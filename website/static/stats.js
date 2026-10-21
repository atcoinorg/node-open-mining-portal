var poolWorkerData = [];
var poolHashrateData = [];
var poolBlockData = [];
var poolWorkerChart;
var poolHashrateChart;
var poolBlockChart;
var statData = [];
var poolKeys = [];
var chartSettings = document.getElementById('topCharts').dataset;
var statsInterval = Number(chartSettings.interval) || 60;
var statsRetention = Number(chartSettings.retention) || 43200;

function buildChartData() {
    var pools = {};
    poolKeys = [];
    statData.forEach(function(snapshot) {
        Object.keys(snapshot.pools).forEach(function(pool) {
            if (poolKeys.indexOf(pool) === -1) poolKeys.push(pool);
        });
    });
    poolKeys.forEach(function(pool) { pools[pool] = {hashrate: [], workers: [], blocks: []}; });
    statData.forEach(function(snapshot, index) {
        var previous = statData[index - 1];
        var missing = previous && snapshot.time - previous.time > statsInterval * 2.5;
        poolKeys.forEach(function(name) {
            var series = pools[name];
            if (missing) {
                // Missing observations are unknown, including the pending-block balance.
                var gapTime = (previous.time + statsInterval) * 1000;
                series.hashrate.push([gapTime, null]);
                series.workers.push([gapTime, null]);
                series.blocks.push([gapTime, null]);
            }
            var pool = snapshot.pools[name];
            var time = snapshot.time * 1000;
            series.hashrate.push([time, pool ? pool.hashrate : null]);
            series.workers.push([time, pool ? pool.workerCount : null]);
            series.blocks.push([time, pool ? pool.blocks.pending : null]);
        });
    });
    function data(metric, previous) {
        return poolKeys.map(function(name) {
            var old = previous.filter(function(series) { return series.key === name; })[0];
            return {key: name, values: pools[name][metric], disabled: old ? old.disabled : false};
        });
    }
    poolWorkerData = data('workers', poolWorkerData);
    poolHashrateData = data('hashrate', poolHashrateData);
    poolBlockData = data('blocks', poolBlockData);
}

function getReadableHashRateString(hashrate) {
    var units = ['H', 'KH', 'MH', 'GH', 'TH', 'PH'];
    var index = 0;
    while (hashrate >= 1000 && index < units.length - 1) { hashrate /= 1000; index++; }
    return hashrate.toFixed(2) + ' ' + units[index];
}

function timeOfDayFormat(timestamp) {
    return window.formatTime(timestamp);
}

function displayCharts() {
    function chart(selector, values, format, step, assign) {
        nv.addGraph(function() {
            var model = nv.models.lineChart()
                .color(['#4b0082', '#9b63c4', '#c3a0df', '#6946a0'])
                .margin({left: 65, right: 24})
                .x(function(d) { return d[0]; })
                .y(function(d) { return d[1]; })
                .defined(function(d) { return d[1] !== null && isFinite(d[1]); })
                .forceY([0])
                .interpolate(step ? 'step-after' : 'linear')
                .useInteractiveGuideline(true);
            model.xAxis.tickFormat(timeOfDayFormat);
            model.yAxis.tickFormat(format);
            assign(model);
            d3.select(selector).datum(values()).call(model);
            return model;
        });
    }
    chart('#poolWorkers', function() { return poolWorkerData; }, d3.format('d'), true, function(c) { poolWorkerChart = c; });
    chart('#poolHashrate', function() { return poolHashrateData; }, getReadableHashRateString, false, function(c) { poolHashrateChart = c; });
    chart('#poolBlocks', function() { return poolBlockData; }, d3.format('d'), true, function(c) { poolBlockChart = c; });
}

function TriggerChartUpdates() {
    [[poolWorkerChart, '#poolWorkers', poolWorkerData],
     [poolHashrateChart, '#poolHashrate', poolHashrateData],
     [poolBlockChart, '#poolBlocks', poolBlockData]].forEach(function(item) {
        if (item[0]) { d3.select(item[1]).datum(item[2]); item[0].update(); }
    });
}
nv.utils.windowResize(TriggerChartUpdates);

function mergeStats(snapshots) {
    var byTime = {};
    snapshots.concat(statData).forEach(function(snapshot) { byTime[snapshot.time] = snapshot; });
    statData = Object.keys(byTime).map(function(time) { return byTime[time]; }).sort(function(a, b) { return a.time - b.time; });
    if (statData.length) {
        var cutoff = statData[statData.length - 1].time - statsRetention;
        statData = statData.filter(function(snapshot) { return snapshot.time >= cutoff; });
    }
    buildChartData();
}

$.getJSON('/api/pool_stats', function(data) {
    mergeStats(data);
    displayCharts();
});

statsSource.addEventListener('message', function(e) {
    var snapshot = JSON.parse(e.data);
    // Replace duplicate timestamps instead of discarding an arbitrary oldest point.
    statData = statData.filter(function(s) { return s.time !== snapshot.time; });
    mergeStats([snapshot]);
    TriggerChartUpdates();
});
