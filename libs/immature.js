var http = require('http');
var async = require('async');

// Use the same pool output and weighted round shares as the payment processor.
module.exports = function(client, coin, pool, callback) {
    var rpc = pool.paymentProcessing && pool.paymentProcessing.daemon;
    if (!rpc) return callback(null, {});
    client.smembers(coin + ':blocksPending', function(error, blocks) {
        if (error) return callback(error);
        if (!blocks.length) return callback(null, {});
        client.multi(blocks.map(function(block) {
            return ['hgetall', coin + ':shares:round' + block.split(':')[2]];
        })).exec(function(error, rounds) {
            if (error) return callback(error);
            var amounts = Object.create(null);
            async.eachLimit(blocks, 4, function(block, done) {
                var shares = rounds[blocks.indexOf(block)];
                if (!shares) return done();
                var finished = false;
                var timer;
                function finish(error) {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timer);
                    done(error);
                }
                var req = http.request({hostname: rpc.host, port: rpc.port,
                    path: rpc.path || '/', method: 'POST', auth: rpc.user + ':' + rpc.password}, function(res) {
                    var body = '';
                    res.on('data', function(chunk) {
                        if (finished) return;
                        body += chunk;
                        if (Buffer.byteLength(body) > 2 * 1024 * 1024) {
                            finish(new Error('Immature rewards RPC response too large'));
                            req.destroy(); res.destroy();
                        }
                    });
                    res.on('error', function() {finish(new Error('Immature rewards RPC response failed'));});
                    res.on('aborted', function() {finish(new Error('Immature rewards RPC response aborted'));});
                    res.on('end', function() {
                        if (finished) return;
                        try {
                            var result = JSON.parse(body);
                            if (res.statusCode !== 200 || result.error || !result.result)
                                return finish(new Error('Unable to read pending block transaction'));
                            var details = result.result.details || [];
                            var output = details.filter(function(d) { return d.address === pool.address; })[0];
                            if (!output && details.length === 1) output = details[0];
                            if (output && output.category === 'immature') {
                                var reward = Math.round(Number(output.amount || output.value || 0) * 1e8);
                                var total = Object.keys(shares).reduce(function(sum, worker) {
                                    return sum + Number(shares[worker]);
                                }, 0);
                                if (total > 0) Object.keys(shares).forEach(function(worker) {
                                    amounts[worker] = (amounts[worker] || 0) + Math.floor(reward * Number(shares[worker]) / total);
                                });
                            }
                            finish();
                        } catch (e) { finish(new Error('Invalid immature rewards response')); }
                    });
                });
                timer = setTimeout(function() {
                    finish(new Error('Immature rewards RPC timeout'));
                    req.destroy();
                }, 10000);
                req.on('error', function() {finish(new Error('Immature rewards RPC request failed'));});
                req.end(JSON.stringify({id: 1, method: 'gettransaction', params: [block.split(':')[1]]}));
            }, function(error) {
                if (error) return callback(error);
                Object.keys(amounts).forEach(function(worker) { amounts[worker] /= 1e8; });
                callback(null, amounts);
            });
        });
    });
};
