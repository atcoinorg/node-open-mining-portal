var redis = require('redis');
var async = require('async');

var stats = require('./stats.js');
var minerStats = require('./minerStats.js');
var workerList = require('./workerList.js');

module.exports = function(logger, portalConfig, poolConfigs){


    var _this = this;

    var portalStats = this.stats = new stats(logger, portalConfig, poolConfigs);

    this.liveStatConnections = {};

    this.handleApiRequest = function(req, res, next){
        switch(req.params.method){
            case 'workers':
                res.json(workerList(portalStats.stats, req.query));
                return;
            case 'miner_stats':
                if (!['worker', 'address'].includes(req.query.type) || typeof req.query.id !== 'string' || !req.query.id ||
                    (req.query.address !== undefined && typeof req.query.address !== 'string')) {
                    res.status(400).json({error: 'Specify type=worker or address and an id.'});
                    return;
                }
                try {
                    res.json(minerStats(portalStats.statHistory, portalStats.stats, req.query.type,
                        req.query.id, req.query.address, portalConfig.website.stats.hashrateWindow));
                } catch (error) {
                    res.status(error.status || 500).json({error: error.message});
                }
                return;
            case 'stats':
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(portalStats.statsString);
                return;
            case 'pool_stats':
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(portalStats.statPoolHistory));
                return;
            case 'live_stats':
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                });
                res.write('\n');
                var uid = Math.random().toString();
                _this.liveStatConnections[uid] = res;
                req.on("close", function() {
                    delete _this.liveStatConnections[uid];
                });

                return;
            default:
                next();
        }
    };


    this.handleAdminApiRequest = function(req, res, next){
        switch(req.params.method){
            case 'pools': {
                res.end(JSON.stringify({result: poolConfigs}));
                return;
            }
            default:
                next();
        }
    };

};
