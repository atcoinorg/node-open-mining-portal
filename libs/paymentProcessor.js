var fs = require('fs');
var crypto = require('crypto');

var redis = require('redis');
var async = require('async');

var Stratum = require('stratum-pool');
var util = require('stratum-pool/lib/util.js');
var paymentMath = require('./paymentMath');


module.exports = function(logger){

    var poolConfigs = JSON.parse(process.env.pools);

    var enabledPools = [];

    Object.keys(poolConfigs).forEach(function(coin) {
        var poolOptions = poolConfigs[coin];
        if (poolOptions.paymentProcessing &&
            poolOptions.paymentProcessing.enabled)
            enabledPools.push(coin);
    });

    async.filter(enabledPools, function(coin, callback){
        SetupForPool(logger, poolConfigs[coin], function(setupResults){
            callback(setupResults);
        });
    }, function(coins){
        coins.forEach(function(coin){

            var poolOptions = poolConfigs[coin];
            var processingConfig = poolOptions.paymentProcessing;
            var logSystem = 'Payments';
            var logComponent = coin;

            logger.debug(logSystem, logComponent, 'Payment processing setup to run every '
                + processingConfig.paymentInterval + ' second(s) with daemon ('
                + processingConfig.daemon.user + '@' + processingConfig.daemon.host + ':' + processingConfig.daemon.port
                + ') and redis (' + poolOptions.redis.host + ':' + poolOptions.redis.port + ')');

        });
    });
};


function SetupForPool(logger, poolOptions, setupFinished){


    var coin = poolOptions.coin.name;
    var processingConfig = poolOptions.paymentProcessing;

    var logSystem = 'Payments';
    var logComponent = coin;

    if (processingConfig.feeRate != null &&
        (!Number.isFinite(processingConfig.feeRate) || processingConfig.feeRate <= 0)) {
        logger.error(logSystem, logComponent, 'paymentProcessing.feeRate must be a positive number in atomic units per virtual byte');
        setupFinished(false);
        return;
    }

    var daemon = new Stratum.daemon.interface([processingConfig.daemon], function(severity, message){
        logger[severity](logSystem, logComponent, message);
    });
    var redisClient = redis.createClient(poolOptions.redis.port, poolOptions.redis.host);

    redisClient.on('error', function() {
        logger.error(logSystem, logComponent, 'Payment Redis connection failed; preserve payment journals for reconciliation');
    });

    var magnitude;
    var minPaymentSatoshis;
    var coinPrecision;

    var paymentInterval;
    var processing = false;
    var paymentsDisabled = false;

    async.parallel([
        function(callback){
            daemon.cmd('validateaddress', [poolOptions.address], function(result) {
                if (result.error){
                    logger.error(logSystem, logComponent, 'Error with payment processing daemon ' + JSON.stringify(result.error));
                    callback(true);
                }
                else if (!result.response || !result.response.ismine) {
                            daemon.cmd('getaddressinfo', [poolOptions.address], function(result) {
                        if (result.error){
                            logger.error(logSystem, logComponent, 'Error with payment processing daemon, getaddressinfo failed ... ' + JSON.stringify(result.error));
                            callback(true);
                        }
                        else if (!result.response || !result.response.ismine) {
                            logger.error(logSystem, logComponent,
                                    'Daemon does not own pool address - payment processing can not be done with this daemon, '
                                    + JSON.stringify(result.response));
                            callback(true);
                        }
                        else{
                            callback()
                        }
                    }, true);
                }
                else{
                    callback()
                }
            }, true);
        },
        function(callback){
            daemon.cmd('getbalance', [], function(result){
                if (result.error){
                    callback(true);
                    return;
                }
                try {
                    coinPrecision = poolOptions.coin.precision == null ? 8 : poolOptions.coin.precision;
                    if (!Number.isInteger(coinPrecision) || coinPrecision < 0 || coinPrecision > 8) throw new Error('Invalid coin precision');
                    magnitude = Math.pow(10, coinPrecision);
                    minPaymentSatoshis = paymentMath.toUnits(processingConfig.minimumPayment, coinPrecision);
                    if (!Number.isSafeInteger(minPaymentSatoshis) || minPaymentSatoshis <= 0 ||
                        !Number.isFinite(processingConfig.paymentInterval) || processingConfig.paymentInterval <= 0)
                        throw new Error('Invalid payment threshold or interval');
                    callback();
                }
                catch(e){
                    logger.error(logSystem, logComponent, 'Invalid payment precision: ' + e.message);
                    callback(true);
                }

            }, true, true);
        }
    ], function(err){
        if (err){
            setupFinished(false);
            return;
        }
        paymentInterval = setInterval(function(){
            try {
                processPayments();
            } catch(e){
                throw e;
            }
        }, processingConfig.paymentInterval * 1000);
        setTimeout(processPayments, 100);
        setupFinished(true);
    });




    var satoshisToCoins = function(satoshis){
        if (!Number.isSafeInteger(satoshis)) throw new Error('Unsafe monetary amount');
        var value = parseFloat((satoshis / magnitude).toFixed(coinPrecision));
        if (paymentMath.toUnits(Math.abs(value), coinPrecision) !== Math.abs(satoshis))
            throw new Error('Amount cannot be represented exactly by wallet JSON-RPC');
        return value;
    };

    var coinsToSatoshies = function(coins){
        return paymentMath.toUnits(coins, coinPrecision);
    };

    /* Deal with numbers in smallest possible units (satoshis) as much as possible. This greatly helps with accuracy
       when rounding and whatnot. When we are storing numbers for only humans to see, store in whole coin units. */

    var processPayments = function(){
        if (processing || paymentsDisabled) return;
        processing = true;
        var paymentReceipt = null;
        var cycleOwned = false;
        var cycleToken = crypto.randomUUID();
        var accountingStarted = false;
        var roundCounts = {pending: 0, immature: 0, mature: 0};

        var startPaymentProcess = Date.now();

        var timeSpentRPC = 0;
        var timeSpentRedis = 0;

        var startTimeRedis;
        var startTimeRPC;

        var startRedisTimer = function(){ startTimeRedis = Date.now() };
        var endRedisTimer = function(){ timeSpentRedis += Date.now() - startTimeRedis };

        var startRPCTimer = function(){ startTimeRPC = Date.now(); };
        var endRPCTimer = function(){ timeSpentRPC += Date.now() - startTimeRPC };

        async.waterfall([
            function(callback) {
                // No lease expiry: a paused or crashed owner must never overlap another sender.
                // A crash requires operator reconciliation before removal of this fence.
                redisClient.set(coin + ':paymentCycleLock', cycleToken, 'NX', function(error, stored) {
                    cycleOwned = !error && !!stored;
                    if (error || !stored) return callback(error || new Error('Payment cycle locked; reconcile previous owner before unlocking'));
                    redisClient.get(coin + ':paymentCommitPending', function(readError, pending) {
                        callback(readError || (pending ? new Error('Unresolved accounting commit; manual reconciliation required') : null));
                    });
                });
            },

            /* Call redis to get an array of rounds - which are coinbase transactions and block heights from submitted
               blocks. */
            function(callback){

                startRedisTimer();
                redisClient.multi([
                    ['hgetall', coin + ':balances'],
                    ['smembers', coin + ':blocksPending']
                ]).exec(function(error, results){
                    endRedisTimer();

                    if (error){
                        logger.error(logSystem, logComponent, 'Could not get blocks from redis ' + JSON.stringify(error));
                        callback(true);
                        return;
                    }



                    var workers = Object.create(null);
                    try {
                        for (var w in results[0]) {
                            if (typeof results[0][w] !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(results[0][w])) throw new Error('Invalid saved balance');
                            workers[w] = {balance: coinsToSatoshies(results[0][w])};
                        }
                    } catch (e) { callback(e); return; }

                    roundCounts.pending = results[1].length;
                    var rounds = results[1].map(function(r){
                        var details = r.split(':');
                        return {
                            blockHash: details[0],
                            txHash: details[1],
                            height: details[2],
                            serialized: r
                        };
                    });

                    callback(null, workers, rounds);
                });
            },

            /* Does a batch rpc call to daemon with all the transaction hashes to see if they are confirmed yet.
               It also adds the block reward amount to the round object - which the daemon gives also gives us. */
            function(workers, rounds, callback){

                var batchRPCcommand = rounds.map(function(r){
                    return ['gettransaction', [r.txHash]];
                });

                // Modern wallet RPC uses an empty dummy account in sendmany.
                var walletRpc = (processingConfig.daemon.path || '').indexOf('/wallet/') === 0;
                if (!walletRpc)
                    batchRPCcommand.push(['getaccount', [poolOptions.address]]);
                if (batchRPCcommand.length === 0) {
                    callback(null, workers, rounds, '');
                    return;
                }

                startRPCTimer();
                daemon.batchCmd(batchRPCcommand, function(error, txDetails){
                    endRPCTimer();

                    if (error || !txDetails){
                        logger.error(logSystem, logComponent, 'Check finished - daemon rpc error with batch gettransactions '
                            + JSON.stringify(error));
                        callback(true);
                        return;
                    }

                    var addressAccount = '';

                    txDetails.forEach(function(tx, i){

                        if (!walletRpc && i === txDetails.length - 1){
                            addressAccount = tx.result;
                            return;
                        }

                        var round = rounds[i];

                        if (tx.error && tx.error.code === -5){
                            logger.warning(logSystem, logComponent, 'Daemon reports invalid transaction: ' + round.txHash);
                            round.category = 'kicked';
                            return;
                        }
                        else if (tx.error || !tx.result){
                            logger.error(logSystem, logComponent, 'Odd error with gettransaction ' + round.txHash + ' '
                                + JSON.stringify(tx));
                            return;
                        }
                        else if (!tx.result.details || (tx.result.details && tx.result.details.length === 0)){
                            logger.warning(logSystem, logComponent, 'Daemon reports no details for transaction: ' + round.txHash);
                            round.category = 'kicked';
                            return;
                        }

                        var generationTx = tx.result.details.filter(function(tx){
                            return tx.address === poolOptions.address;
                        })[0];


                        if (!generationTx && tx.result.details.length === 1){
                            generationTx = tx.result.details[0];
                        }

                        if (!generationTx){
                            logger.error(logSystem, logComponent, 'Missing output details to pool address for transaction '
                                + round.txHash);
                            return;
                        }

                        round.category = generationTx.category;
                        if (round.category === 'immature') roundCounts.immature++;
                        if (round.category === 'generate') roundCounts.mature++;
                        if (round.category === 'generate') {
                            round.reward = generationTx.amount || generationTx.value;
                        }

                    });

                    var canDeleteShares = function(r){
                        for (var i = 0; i < rounds.length; i++){
                            var compareR = rounds[i];
                            if ((compareR.height === r.height)
                                && (compareR.category !== 'kicked')
                                && (compareR.category !== 'orphan')
                                && (compareR.serialized !== r.serialized)){
                                return false;
                            }
                        }
                        return true;
                    };


                    //Filter out all rounds that are immature (not confirmed or orphaned yet)
                    rounds = rounds.filter(function(r){
                        switch (r.category) {
                            case 'orphan':
                            case 'kicked':
                                r.canDeleteShares = canDeleteShares(r);
                            case 'generate':
                                return true;
                            default:
                                return false;
                        }
                    });


                    callback(null, workers, rounds, addressAccount);

                });
            },


            /* Does a batch redis call to get shares contributed to each round. Then calculates the reward
               amount owned to each miner for each round. */
            function(workers, rounds, addressAccount, callback){


                var shareLookups = rounds.map(function(r){
                    return ['hgetall', coin + ':shares:round' + r.height]
                });

                startRedisTimer();
                redisClient.multi(shareLookups).exec(function(error, allWorkerShares){
                    endRedisTimer();

                    if (error){
                        callback('Check finished - redis error with multi get rounds share');
                        return;
                    }


                    var missingRound = rounds.find(function(round, i) {
                        return !allWorkerShares[i] || !Object.keys(allWorkerShares[i]).length;
                    });
                    if (missingRound) {
                        callback(new Error('Missing worker shares for round ' + missingRound.height + '; rewards remain pending'));
                        return;
                    }
                    try {
                    rounds.forEach(function(round, i){
                        var workerShares = allWorkerShares[i];

                        if (!workerShares){
                            logger.error(logSystem, logComponent, 'No worker shares for round: '
                                + round.height + ' blockHash: ' + round.blockHash);
                            return;
                        }

                        switch (round.category){
                            case 'kicked':
                            case 'orphan':
                                round.workerShares = workerShares;
                                break;

                            case 'generate':
                                /* We found a confirmed block! Now get the reward for it and calculate how much
                                   we owe each miner based on the shares they submitted during that block round. */
                                var reward = coinsToSatoshies(round.reward);

                                var allocations = paymentMath.allocate(reward, workerShares);
                                for (var workerAddress in workerShares){
                                    var workerRewardTotal = allocations[workerAddress];
                                    var worker = workers[workerAddress] = (workers[workerAddress] || {});
                                    worker.reward = (worker.reward || 0) + workerRewardTotal;
                                }
                                break;
                        }
                    });

                    } catch (e) { callback(e); return; }
                    callback(null, workers, rounds, addressAccount);
                });
            },


            /* Calculate if any payments are ready to be sent and trigger them sending
             Get balance different for each address and pass it along as object of latest balances such as
             {worker1: balance1, worker2, balance2}
             when deciding the sent balance, it the difference should be -1*amount they had in db,
             if not sending the balance, the differnce should be +(the amount they earned this round)
             */
            function(workers, rounds, addressAccount, callback) {

                var trySend = function () {
                    var addressAmounts = {};
                    var totalSent = 0;
                    for (var w in workers) {
                        var worker = workers[w];
                        worker.balance = worker.balance || 0;
                        worker.reward = worker.reward || 0;
                        var toSend = worker.balance + worker.reward;
                        if (!Number.isSafeInteger(toSend) || toSend < 0) { callback(new Error('Unsafe worker amount')); return; }
                        if (toSend >= minPaymentSatoshis) {
                            totalSent += toSend;
                            if (!Number.isSafeInteger(totalSent)) { callback(new Error('Unsafe payment total')); return; }
                            var address = worker.address = (worker.address || getProperAddress(w));
                            worker.sent = satoshisToCoins(toSend);
                            addressAmounts[address] = satoshisToCoins(
                                coinsToSatoshies(addressAmounts[address] || 0) + toSend);
                            worker.balanceChange = Math.min(worker.balance, toSend) * -1;
                        }
                        else {
                            worker.balanceChange = Math.max(toSend - worker.balance, 0);
                            worker.sent = 0;
                        }
                        satoshisToCoins(worker.balanceChange);
                    }

                    if (Object.keys(addressAmounts).length === 0){
                        callback(null, workers, rounds);
                        return;
                    }

                    satoshisToCoins(totalSent); // Validate the aggregate before any wallet call.
                    var journalKey = coin + ':paymentInFlight';
                    var journal = {id: 'pool-payment:' + crypto.randomUUID(), createdAt: Math.floor(Date.now() / 1000),
                        amounts: addressAmounts, workers: workers, rounds: rounds};

                    function accepted(txid, time, saved) {
                        paymentReceipt = {txid: txid, time: time, amount: Object.keys(saved.amounts).reduce(function(total, address) {
                            return total + coinsToSatoshies(saved.amounts[address]);
                        }, 0) / magnitude};
                        logger.debug(logSystem, logComponent, 'Payment transaction ' + txid + ': ' + paymentReceipt.amount);
                        callback(null, saved.workers, saved.rounds);
                    }
                    function recover(saved) {
                        // A timed-out send can still have reached the wallet. Search by the
                        // durable unique comment before considering another transaction.
                        daemon.cmd('listtransactions', ['*', 1000, 0], function(result) {
                            if (result.error || !Array.isArray(result.response)) {
                                callback(new Error('Unable to reconcile previous payment; no new transfer attempted'));
                                return;
                            }
                            var ids = Array.from(new Set(result.response.filter(function(tx) {
                                return tx.category === 'send' && tx.comment === saved.id;
                            }).map(function(tx) { return tx.txid; })));
                            if (ids.length !== 1) {
                                callback(new Error('Previous payment response is unknown; waiting for wallet reconciliation, no new transfer attempted'));
                                return;
                            }
                            daemon.cmd('gettransaction', [ids[0]], function(details) {
                                var tx = details.response;
                                if (details.error || !tx || !Number.isSafeInteger(tx.time) || tx.time < 0 || tx.abandoned || tx.confirmations < 0 || (tx.walletconflicts || []).length) {
                                    callback(new Error('Previous payment transaction requires reconciliation'));
                                    return;
                                }
                                var actual = {};
                                (tx.details || []).filter(function(d) { return d.category === 'send'; }).forEach(function(d) {
                                    actual[d.address] = (actual[d.address] || 0) + coinsToSatoshies(-d.amount);
                                });
                                var addresses = Object.keys(saved.amounts);
                                if (addresses.length !== Object.keys(actual).length || addresses.some(function(address) {
                                    return actual[address] !== coinsToSatoshies(saved.amounts[address]);
                                })) {
                                    callback(new Error('Previous payment outputs do not match saved rewards'));
                                    return;
                                }
                                accepted(ids[0], tx.time, saved);
                            }, true);
                        }, true);
                    }
                    redisClient.set(journalKey, JSON.stringify(journal), 'NX', function(error, stored) {
                        if (error) { callback(error); return; }
                        if (!stored) {
                            redisClient.get(journalKey, function(readError, value) {
                                if (readError) { callback(readError); return; }
                                try {
                                    var saved = JSON.parse(value);
                                    if (!saved || !/^pool-payment:[a-f0-9-]{36}$/.test(saved.id) ||
                                        !saved.amounts || !saved.workers || !Array.isArray(saved.rounds) ||
                                        !Number.isSafeInteger(saved.createdAt) || saved.createdAt < 0 ||
                                        !Object.keys(saved.amounts).length) throw new Error('Invalid journal');
                                    var expected = Object.create(null), sum = 0;
                                    Object.keys(saved.workers).forEach(function(name) {
                                        var worker = saved.workers[name];
                                        if (!worker || !Number.isSafeInteger(worker.balance) || worker.balance < 0 ||
                                            !Number.isSafeInteger(worker.reward) || worker.reward < 0 ||
                                            !Number.isSafeInteger(worker.balanceChange) || !Number.isFinite(worker.sent) || worker.sent < 0)
                                            throw new Error('Invalid journal worker');
                                        if (worker.sent > 0) {
                                            var address = getProperAddress(name);
                                            if (worker.address !== address) throw new Error('Invalid journal address');
                                            var units = coinsToSatoshies(worker.sent);
                                            if (units !== worker.balance + worker.reward || worker.balanceChange !== -worker.balance)
                                                throw new Error('Invalid journal reward');
                                            expected[address] = (expected[address] || 0) + units;
                                            sum += units;
                                        }
                                    });
                                    if (!Number.isSafeInteger(sum) || Object.keys(expected).length !== Object.keys(saved.amounts).length ||
                                        Object.keys(expected).some(function(address) {return expected[address] !== coinsToSatoshies(saved.amounts[address]);}))
                                        throw new Error('Invalid journal totals');
                                    recover(saved);
                                }
                                catch (_) { callback(new Error('Invalid saved payment journal; no transfer attempted')); }
                            });
                            return;
                        }
                        var sendParams = [addressAccount || '', addressAmounts, 1, journal.id];
                        if (processingConfig.feeRate != null) {
                            // Explicit sat/vB avoids failures when wallet fee estimation has no data.
                            sendParams.push([], null, null, 'unset', processingConfig.feeRate);
                        }
                        daemon.cmd('sendmany', sendParams, function(result) {
                            if (result.error) {
                                logger.error(logSystem, logComponent, 'Error trying to send payments with RPC sendmany ' + JSON.stringify(result.error));
                                if ([-3, -5, -6, -8, -13, -32602].includes(result.error.code)) {
                                    // A definite wallet rejection is safe to retry. Transport errors
                                    // retain the journal because the transaction may already exist.
                                    redisClient.del(journalKey, function(deleteError) {
                                        callback(deleteError || new Error(result.error.message || 'Wallet rejected payment'));
                                    });
                                } else callback(new Error('Wallet response unknown: ' + result.error.message + '; payment saved for reconciliation'));
                                return;
                            }
                            if (typeof result.response !== 'string' || !/^[a-f0-9]{64}$/i.test(result.response)) {
                                callback(new Error('Wallet returned no valid transaction ID; payment saved for reconciliation'));
                                return;
                            }
                            accepted(result.response, Math.floor(Date.now() / 1000), journal);
                        }, true, true);
                    });
                };
                // Validate recipients with this wallet/network before preparing any transfer.
                var recipients = Object.keys(workers).filter(function(name) {
                    return (workers[name].balance || 0) + (workers[name].reward || 0) >= minPaymentSatoshis;
                });
                async.eachSeries(recipients, function(name, done) {
                    var address;
                    try { address = getProperAddress(name); } catch (_) { done(new Error('Invalid recipient')); return; }
                    daemon.cmd('validateaddress', [address], function(result) {
                        if (result.error || !result.response || result.response.isvalid !== true) return done(new Error('Invalid payment recipient'));
                        done();
                    }, true);
                }, function(error) {
                    if (error) { callback(error); return; }
                    try { trySend(); } catch (e) { callback(e); }
                });

            },
            function(workers, rounds, callback){

                var totalPaid = 0;

                var balanceUpdateCommands = [];
                var workerPayoutsCommand = [];

                for (var w in workers) {
                    var worker = workers[w];
                    if (worker.balanceChange !== 0){
                        balanceUpdateCommands.push([
                            'hincrbyfloat',
                            coin + ':balances',
                            w,
                            satoshisToCoins(worker.balanceChange)
                        ]);
                    }
                    if (worker.sent !== 0){
                        if (paymentReceipt) workerPayoutsCommand.push(['hset', coin + ':paymentHistory',
                            paymentReceipt.txid + ':' + w,
                            JSON.stringify({worker: w, txid: paymentReceipt.txid, time: paymentReceipt.time, amount: worker.sent})]);
                        if (paymentReceipt) workerPayoutsCommand.push(['hset', coin + ':paymentReceipts', w,
                            JSON.stringify({txid: paymentReceipt.txid, time: paymentReceipt.time, amount: worker.sent})]);
                        workerPayoutsCommand.push(['hincrbyfloat', coin + ':payouts', w, worker.sent]);
                        totalPaid += coinsToSatoshies(worker.sent);
                    }
                }



                var movePendingCommands = [];
                var roundsToDelete = [];
                var orphanMergeCommands = [];

                var moveSharesToCurrent = function(r){
                    var workerShares = r.workerShares;
                    Object.keys(workerShares).forEach(function(worker){
                        orphanMergeCommands.push(['hincrbyfloat', coin + ':shares:roundCurrent',
                            worker, workerShares[worker]]);
                    });
                };

                rounds.forEach(function(r){

                    switch(r.category){
                        case 'kicked':
                            movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksKicked', r.serialized]);
                        case 'orphan':
                            movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksOrphaned', r.serialized]);
                            if (r.canDeleteShares){
                                moveSharesToCurrent(r);
                                roundsToDelete.push(coin + ':shares:round' + r.height);
                            }
                            return;
                        case 'generate':
                            movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksConfirmed', r.serialized]);
                            roundsToDelete.push(coin + ':shares:round' + r.height);
                            return;
                    }

                });

                var finalRedisCommands = [];

                if (movePendingCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(movePendingCommands);

                if (orphanMergeCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(orphanMergeCommands);

                if (balanceUpdateCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(balanceUpdateCommands);

                if (workerPayoutsCommand.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(workerPayoutsCommand);

                if (roundsToDelete.length > 0)
                    finalRedisCommands.push(['del'].concat(roundsToDelete));


                if (totalPaid !== 0)
                    finalRedisCommands.push(['hincrbyfloat', coin + ':stats', 'totalPaid', satoshisToCoins(totalPaid)]);

                if (finalRedisCommands.length === 0){
                    callback();
                    return;
                }

                if (paymentReceipt) finalRedisCommands.push(['del', coin + ':paymentInFlight']);
                startRedisTimer();
                // Persist the exact intended accounting before touching any ledger key.
                accountingStarted = true;
                redisClient.set(coin + ':paymentCommitPending', JSON.stringify({cycle: cycleToken,
                    receipt: paymentReceipt, commands: finalRedisCommands}), 'NX', function(commitError, stored) {
                    if (commitError || !stored) { paymentsDisabled = true; callback(commitError || new Error('Unresolved accounting commit')); return; }
                redisClient.multi(finalRedisCommands).exec(function(error, results){
                    endRedisTimer();
                    if (!error && (!Array.isArray(results) || results.some(function(result) { return result instanceof Error || (result && typeof result === 'object' && typeof result.message === 'string'); })))
                        error = new Error('Redis accounting command failed; manual reconciliation required');
                    if (error){
                        paymentsDisabled = true;
                        clearInterval(paymentInterval);
                        logger.error(logSystem, logComponent,
                                'Payments sent but could not update redis. ' + JSON.stringify(error)
                                + ' Disabling payment processing to prevent possible double-payouts. The redis commands in '
                                + coin + '_finalRedisCommands.txt are evidence for reconciliation; never replay them blindly');
                        fs.writeFile(coin + '_finalRedisCommands.txt', JSON.stringify(finalRedisCommands), {mode: 0o600}, function(err){
                            if (err) logger.error(logSystem, logComponent, 'Unable to save local recovery commands; preserve paymentCycleLock and reconcile Redis commit journal');
                        });
                    }
                    if (error) { callback(error); return; }
                    redisClient.del(coin + ':paymentCommitPending', function(clearError) {
                        if (clearError) paymentsDisabled = true;
                        callback(clearError);
                    });
                });
                });
            }

        ], function(error){
            if (cycleOwned && !paymentsDisabled && !(error && accountingStarted)) {
                redisClient.del(coin + ':paymentCycleLock', function(lockError) {
                    if (lockError) { paymentsDisabled = true; clearInterval(paymentInterval); }
                    processing = false;
                });
            } else processing = false;
            var status = {checkedAt: Math.floor(Date.now() / 1000),
                status: error ? "error" : (paymentReceipt ? "paid" : "waiting"),
                pending: roundCounts.pending, immature: roundCounts.immature, mature: roundCounts.mature,
                message: error ? (error.message || String(error)) : ""};
            if (paymentReceipt && !error) {
                status.lastTxid = paymentReceipt.txid;
                status.lastPaidAt = paymentReceipt.time;
                status.lastAmount = paymentReceipt.amount;
            }
            redisClient.hmset(coin + ":paymentStatus", status, function(statusError) {
                if (statusError) logger.error(logSystem, logComponent, "Unable to save payment status: " + statusError.message);
            });

            var paymentProcessTime = Date.now() - startPaymentProcess;
            logger.debug(logSystem, logComponent, 'Finished interval - time spent: '
                + paymentProcessTime + 'ms total, ' + timeSpentRedis + 'ms redis, '
                + timeSpentRPC + 'ms daemon RPC');

        });
    };


    var getProperAddress = function(address){
        address = address.split('.')[0];
        if (address.length === 40){
            return util.addressFromEx(poolOptions.address, address);
        }
        else return address;
    };


}
