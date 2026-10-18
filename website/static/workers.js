$(function() {
    var search = document.getElementById('workerSearch');
    var limit = document.getElementById('workerLimit');
    var tbody = document.getElementById('workerRows');
    var state, request, timer;
    function readState() {
        var params = new URLSearchParams(location.search);
        state = {search: params.get('search') || '', sort: params.get('sort') || 'shares',
            direction: params.get('direction') || 'desc', page: params.get('page') || 1, limit: params.get('limit') || 25};
        search.value = state.search;
        limit.value = ['25', '50', '100'].includes(String(state.limit)) ? state.limit : '25';
    }
    function cell(row, value, className) {
        var td = document.createElement('td');
        td.dataset.label = ['Worker', 'Address', 'Shares', 'Invalid shares', 'Efficiency', 'Hashrate', 'Immature', 'Paid'][row.children.length];
        if (className) td.className = className;
        td.textContent = value;
        row.appendChild(td);
        return td;
    }
    function link(cell, label, href, className) {
        var a = document.createElement('a');
        a.textContent = label; a.href = href; a.className = className; cell.appendChild(a);
    }
    function load(push) {
        if (request) request.abort();
        if (push) history.pushState(null, '', '/workers?' + new URLSearchParams(state).toString());
        tbody.setAttribute('aria-busy', 'true');
        request = $.getJSON('/api/workers', state).done(function(data) {
            state.page = data.page; state.sort = data.sort; state.direction = data.direction; state.limit = data.limit;
            tbody.textContent = '';
            data.rows.forEach(function(w) {
                var row = document.createElement('tr');
                var name = cell(row, '');
                link(name, w.worker || 'Unnamed worker', '/worker/' + encodeURIComponent(w.worker || w.name) + '/charts?address=' + encodeURIComponent(w.address), 'worker-name');
                var pool = document.createElement('small'); pool.className = 'worker-pool'; pool.textContent = w.pool + ' · ' + w.symbol; name.appendChild(pool);
                link(cell(row, ''), w.address, '/address/' + encodeURIComponent(w.address) + '/charts', 'worker-address');
                cell(row, Math.floor(w.shares)); cell(row, Math.floor(w.invalidShares));
                cell(row, (w.shares > 0 ? Math.floor(10000 * w.shares / (w.shares + w.invalidShares)) / 100 : 0) + '%');
                cell(row, w.hashrate || '0.00 KH');
                cell(row, w.immature === null ? '—' : w.immature.toFixed(8), 'worker-reward');
                cell(row, w.paid.toFixed(8), 'worker-reward');
                tbody.appendChild(row);
            });
            if (!data.rows.length) { var row = document.createElement('tr'); var td = cell(row, 'No workers match your search.', 'workers-empty'); td.colSpan = 8; tbody.appendChild(row); }
            document.querySelectorAll('[data-worker-sort]').forEach(function(th) {
                var active = th.dataset.workerSort === data.sort;
                th.setAttribute('aria-sort', active ? (data.direction === 'asc' ? 'ascending' : 'descending') : 'none');
                th.querySelector('.sort-indicator').textContent = active ? (data.direction === 'asc' ? '↑' : '↓') : '↕';
            });
            var start = data.total ? (data.page - 1) * data.limit + 1 : 0;
            document.getElementById('workerCount').textContent = start + '–' + Math.min(data.page * data.limit, data.total) + ' of ' + data.total + ' workers';
            document.getElementById('workerPage').textContent = 'Page ' + data.page + ' of ' + data.pages;
            document.getElementById('workerPrevious').disabled = data.page <= 1;
            document.getElementById('workerNext').disabled = data.page >= data.pages;
        }).fail(function(xhr, status) {
            if (status !== 'abort') document.getElementById('workerCount').textContent = 'Unable to load workers. Please try again.';
        }).always(function() { tbody.removeAttribute('aria-busy'); });
    }
    search.addEventListener('input', function() {
        clearTimeout(timer);
        timer = setTimeout(function() { state.search = search.value; state.page = 1; load(true); }, 250);
    });
    limit.addEventListener('change', function() { state.limit = limit.value; state.page = 1; load(true); });
    document.querySelectorAll('[data-worker-sort] button').forEach(function(button) {
        button.addEventListener('click', function() {
            var sort = button.parentElement.dataset.workerSort;
            state.direction = sort === state.sort ? (state.direction === 'desc' ? 'asc' : 'desc') : (sort === 'worker' || sort === 'address' ? 'asc' : 'desc');
            state.sort = sort; state.page = 1; load(true);
        });
    });
    document.getElementById('workerPrevious').addEventListener('click', function() { state.page--; load(true); });
    document.getElementById('workerNext').addEventListener('click', function() { state.page++; load(true); });
    window.addEventListener('popstate', function() { clearTimeout(timer); readState(); load(false); });
    statsSource.addEventListener('message', function() { load(false); });
    readState(); load(false);
});
