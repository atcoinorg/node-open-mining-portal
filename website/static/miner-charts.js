$(function() {
    var root = document.getElementById('minerCharts');
    var query = {type: root.dataset.type, id: root.dataset.id};
    if (root.dataset.address) query.address = root.dataset.address;
    var charts = {};
    function hashrate(value) {
        var units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s'], i = 0;
        while (value >= 1000 && i < units.length - 1) { value /= 1000; i++; }
        return value.toFixed(2) + ' ' + units[i];
    }
    function number(value) { return value === null ? '—' : value.toLocaleString('en-US', {maximumFractionDigits: 8}); }
    function amount(value) { return value === null ? '—' : value.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}); }
    var configs = [
        {id: 'minerHashrate', key: 'hashrate', label: 'Hashrate', format: hashrate},
        {id: 'minerShares', key: 'shares', label: 'Accepted share difficulty', format: number},
        {id: 'minerImmature', key: 'immature', label: 'Immature ATL', format: amount},
        {id: 'minerPaid', key: 'paid', label: 'Paid ATL', format: amount}
    ];
    var payments = [], paymentPage = 1, paymentLimit = 25;
    function renderPayments() {
        var pages = Math.max(1, Math.ceil(payments.length / paymentLimit));
        paymentPage = Math.min(paymentPage, pages);
            var body = document.getElementById('minerPaymentsRows');
            body.textContent = '';
            document.getElementById('minerPaymentsStatus').textContent = payments.length ? payments.length + ' payment(s)' : 'No recorded payments for this ' + query.type + '.';
            payments.slice((paymentPage - 1) * paymentLimit, paymentPage * paymentLimit).forEach(function(payment) {
                var row = document.createElement('tr');
                ['Paid', payment.txid, number(payment.amount) + ' ' + (payment.symbol || payment.pool),
                    window.formatDateTime(payment.time * 1000)].forEach(function(value, index) {
                    var cell = document.createElement('td');
                    cell.textContent = value;
                    if (index === 1) cell.style.overflowWrap = 'anywhere';
                    row.appendChild(cell);
                });
                body.appendChild(row);
            });
        document.getElementById('paymentCount').textContent = payments.length ?
            ((paymentPage - 1) * paymentLimit + 1) + '–' + Math.min(paymentPage * paymentLimit, payments.length) + ' of ' + payments.length : '0 payments';
        document.getElementById('paymentPage').textContent = 'Page ' + paymentPage + ' of ' + pages;
        document.getElementById('paymentPrevious').disabled = paymentPage <= 1;
        document.getElementById('paymentNext').disabled = paymentPage >= pages;
    }
    document.getElementById('paymentLimit').addEventListener('change', function() {
        paymentLimit = Number(this.value);
        paymentPage = 1;
        renderPayments();
    });
    document.getElementById('paymentPrevious').addEventListener('click', function() {
        if (paymentPage > 1) { paymentPage--; renderPayments(); }
    });
    document.getElementById('paymentNext').addEventListener('click', function() {
        if (paymentPage * paymentLimit < payments.length) { paymentPage++; renderPayments(); }
    });
    function load() {
        $.getJSON('/api/miner_stats', query).done(function(data) {
            payments = data.payments || [];
            renderPayments();
            var status = document.getElementById('minerChartStatus');
            status.textContent = data.workers.length ? (data.type === 'address' ? data.workers.length + ' worker(s) included. ' : '') + 'Updates automatically with pool statistics.' : 'No mining history found for this ' + data.type + '.';
            var latest = data.points[data.points.length - 1];
            document.getElementById('minerSummary').hidden = !latest || !data.workers.length;
            if (latest) {
                root.querySelector('[data-miner-stat="hashrate"]').textContent = hashrate(latest.hashrate);
                ['shares', 'immature', 'paid'].forEach(function(key) {
                    root.querySelector('[data-miner-stat="' + key + '"]').textContent = number(latest[key]);
                });
            }
            configs.forEach(function(config) {
                var series = [{key: config.label, values: data.workers.length ? data.points.map(function(point) {
                    return {x: point.time * 1000, y: point[config.key]};
                }) : []}];
                if (!charts[config.id]) {
                    var chart = charts[config.id] = nv.models.lineChart()
                        .color(['#4b0082']).margin({left: 110, right: 24})
                        .x(function(d) { return d.x; }).y(function(d) { return d.y; })
                        .defined(function(d) { return d.y !== null; })
                        .useInteractiveGuideline(true).showLegend(false).forceY([0]);
                    chart.xAxis.tickFormat(function(time) { return window.formatTime(time); });
                    chart.yAxis.tickFormat(config.format);
                    chart.noData('No mining history available yet');
                    nv.utils.windowResize(chart.update);
                }
                d3.select('#' + config.id).datum(series).call(charts[config.id]);
            });
        }).fail(function(xhr) {
            document.getElementById('minerPaymentsStatus').textContent = 'Unable to load payment history. Please refresh.';
            document.getElementById('minerChartStatus').textContent = xhr.responseJSON && xhr.responseJSON.error || 'Unable to load mining history. Please refresh.';
        });
    }
    load();
    statsSource.addEventListener('message', load);
});
