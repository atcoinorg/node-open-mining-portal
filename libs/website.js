
var fs = require('fs');
var path = require('path');

var async = require('async');
var watch = require('node-watch');
var redis = require('redis');

var dot = require('dot');
var express = require('express');
var bodyParser = require('body-parser');
var compress = require('compression');

var Stratum = require('stratum-pool');
var util = require('stratum-pool/lib/util.js');

var api = require('./api.js');


module.exports = function(logger){

    dot.templateSettings.strip = false;

    var portalConfig = JSON.parse(process.env.portalConfig);
    var poolConfigs = JSON.parse(process.env.pools);

    var websiteConfig = portalConfig.website;

    var portalApi = new api(logger, portalConfig, poolConfigs);
    var portalStats = portalApi.stats;

    var logSystem = 'Website';


    var pageFiles = {
        'index.html': 'index',
        'home.html': '',
        'getting_started.html': 'getting_started',
        'stats.html': 'stats',
        'tbs.html': 'tbs',
        'workers.html': 'workers',
        'api.html': 'api',
        'admin.html': 'admin',
        'mining_key.html': 'mining_key'
    };

    var pageTemplates = {};

    var pageProcessed = {};
    var indexesProcessed = {};

    var keyScriptTemplate = '';
    var keyScriptProcessed = '';


    var processTemplates = function(){

        for (var pageName in pageTemplates){
            if (pageName === 'index') continue;
            pageProcessed[pageName] = pageTemplates[pageName]({
                poolsConfigs: poolConfigs,
                stats: portalStats.stats,
                portalConfig: portalConfig
            });
            indexesProcessed[pageName] = pageTemplates.index({
                page: pageProcessed[pageName],
                selected: pageName,
                stats: portalStats.stats,
                poolConfigs: poolConfigs,
                portalConfig: portalConfig
            });
        }

        //logger.debug(logSystem, 'Stats', 'Website updated to latest stats');
    };



    var readPageFiles = function(files){
        async.each(files, function(fileName, callback){
            var filePath = 'website/' + (fileName === 'index.html' ? '' : 'pages/') + fileName;
            fs.readFile(filePath, 'utf8', function(err, data){
                var pTemp = dot.template(data);
                pageTemplates[pageFiles[fileName]] = pTemp
                callback();
            });
        }, function(err){
            if (err){
                console.log('error reading files for creating dot templates: '+ JSON.stringify(err));
                return;
            }
            processTemplates();
        });
    };


    //If an html file was changed reload it
    watch('website', { recursive: true }, function(event, filename){
        var basename = path.basename(filename);
        if (basename in pageFiles){
            console.log(filename);
            readPageFiles([basename]);
            logger.debug(logSystem, 'Server', 'Reloaded file ' + basename);
        }
    });

    portalStats.getGlobalStats(function(){
        readPageFiles(Object.keys(pageFiles));
    });

    var buildUpdatedWebsite = function(){
        portalStats.getGlobalStats(function(){
            processTemplates();

            var statData = 'data: ' + JSON.stringify(portalStats.stats) + '\n\n';
            for (var uid in portalApi.liveStatConnections){
                var res = portalApi.liveStatConnections[uid];
                if (res.writableLength > 65536) { res.destroy(); continue; }
                if (!res.writableNeedDrain) res.write(statData);
            }

        });
    };

    setInterval(buildUpdatedWebsite, websiteConfig.stats.updateInterval * 1000);


    var buildKeyScriptPage = function(){
        async.waterfall([
            function(callback){
                var client = redis.createClient(portalConfig.redis.port, portalConfig.redis.host);
                client.hgetall('coinVersionBytes', function(err, coinBytes){
                    if (err){
                        client.quit();
                        return callback('Failed grabbing coin version bytes from redis ' + JSON.stringify(err));
                    }
                    callback(null, client, coinBytes || {});
                });
            },
            function (client, coinBytes, callback){
                var enabledCoins = Object.keys(poolConfigs).map(function(c){return c.toLowerCase()});
                var missingCoins = [];
                enabledCoins.forEach(function(c){
                    if (!(c in coinBytes))
                        missingCoins.push(c);
                });
                callback(null, client, coinBytes, missingCoins);
            },
            function(client, coinBytes, missingCoins, callback){
                var coinsForRedis = {};
                async.each(missingCoins, function(c, cback){
                    var coinInfo = (function(){
                        for (var pName in poolConfigs){
                            if (pName.toLowerCase() === c)
                                return {
                                    daemon: poolConfigs[pName].paymentProcessing.daemon,
                                    address: poolConfigs[pName].address,
                                    privateKeyVersion: poolConfigs[pName].coin.privateKeyVersion
                                }
                        }
                    })();
                    // The legacy key generator only supports Base58 addresses.
                    if (/^(?:atcoin|bc|tb|bcrt)1/i.test(coinInfo.address)) {
                        cback();
                        return;
                    }
                    // Never export a wallet private key just to discover a network version.
                    var configured = coinInfo.privateKeyVersion;
                    if (!Number.isInteger(configured) || configured < 0 || configured > 255) {
                        logger.warning(logSystem, c, 'Set coin.privateKeyVersion to enable the legacy Base58 key generator');
                        cback();
                        return;
                    }
                    var vBytePub = util.getVersionByte(coinInfo.address)[0];
                    coinBytes[c] = vBytePub.toString() + ',' + configured.toString();
                    coinsForRedis[c] = coinBytes[c];
                    cback();
                }, function(err){
                    callback(null, client, coinBytes, coinsForRedis);
                });
            },
            function(client, coinBytes, coinsForRedis, callback){
                if (Object.keys(coinsForRedis).length > 0){
                    client.hmset('coinVersionBytes', coinsForRedis, function(err){
                        if (err)
                            logger.error(logSystem, 'Init', 'Failed inserting coin byte version into redis ' + JSON.stringify(err));
                        client.quit();
                    });
                }
                else{
                    client.quit();
                }
                callback(null, coinBytes);
            }
        ], function(err, coinBytes){
            if (err){
                logger.error(logSystem, 'Init', err);
                return;
            }
            try{
                keyScriptTemplate = dot.template(fs.readFileSync('website/key.html', {encoding: 'utf8'}));
                keyScriptProcessed = keyScriptTemplate({coins: coinBytes});
            }
            catch(e){
                logger.error(logSystem, 'Init', 'Failed to read key.html file');
            }
        });

    };
    buildKeyScriptPage();

    var getPage = function(pageId){
        if (Object.hasOwn(pageProcessed, pageId)){
            var requestedPage = pageProcessed[pageId];
            return requestedPage;
        }
    };

    var route = function(req, res, next){
        var pageId = req.params.page || '';
        if (Object.hasOwn(indexesProcessed, pageId)){
            res.header('Content-Type', 'text/html');
            res.end(indexesProcessed[pageId]);
        }
        else
            next();

    };



    var app = express();


    app.disable('x-powered-by');
    app.use(function(req, res, next) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'same-origin');
        res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
        if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
        next();
    });
    app.use('/api', require('./httpLimits')());
    app.use(bodyParser.json({limit: '8kb', strict: true}));

    app.get('/get_page', function(req, res, next){
        var requestedPage = getPage(req.query.id);
        if (requestedPage){
            res.end(requestedPage);
            return;
        }
        next();
    });

    app.get('/key.html', function(req, res, next){
        res.end(keyScriptProcessed);
    });

    var minerChartTemplate = dot.template(fs.readFileSync('website/pages/miner_charts.html', 'utf8'));
    function minerCharts(type) {
        return function(req, res) {
            if (!pageTemplates.index) return res.status(503).send('Statistics are initializing. Please refresh.');
            var id = req.params.id;
            if (!/^[A-Za-z0-9._-]{1,256}$/.test(id) ||
                (req.query.address !== undefined && (typeof req.query.address !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(req.query.address))))
                return res.status(400).json({error: 'Invalid miner identifier'});
            var address = typeof req.query.address === 'string' ? req.query.address : '';
            var page = minerChartTemplate({type: type, id: id, address: address,
                retention: portalConfig.website.stats.historicalRetention,
                window: portalConfig.website.stats.hashrateWindow});
            res.type('html').send(pageTemplates.index({page: page, selected: 'workers'}));
        };
    }
    app.get('/worker/:id/charts', minerCharts('worker'));
    app.get('/address/:id/charts', minerCharts('address'));

    app.get('/:page', route);
    app.get('/', route);

    app.get('/api/:method', function(req, res, next){
        portalApi.handleApiRequest(req, res, next);
    });

    app.post('/api/admin/:method', require('./adminSecurity')(websiteConfig.adminCenter), function(req, res, next) {
        portalApi.handleAdminApiRequest(req, res, next);
    });

    app.use(compress());
    app.use('/static', express.static('website/static'));

    app.use(function(err, req, res, next){
        logger.warning(logSystem, 'HTTP', 'Rejected invalid HTTP request');
        res.status(err.status === 413 ? 413 : 400).json({error: 'Invalid request'});
    });

    try {
        var server = app.listen(portalConfig.website.port, portalConfig.website.host, function () {
            logger.debug(logSystem, 'Server', 'Website started on ' + portalConfig.website.host + ':' + portalConfig.website.port);
        });
        server.requestTimeout = 15000;
        server.headersTimeout = 10000;
        server.keepAliveTimeout = 5000;
        server.maxHeadersCount = 100;
        server.maxConnections = 2048;
    }
    catch(e){
        logger.error(logSystem, 'Server', 'Could not start website on ' + portalConfig.website.host + ':' + portalConfig.website.port
            +  ' - its either in use or you do not have permission');
    }


};
