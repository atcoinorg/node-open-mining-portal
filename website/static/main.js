$(function(){

    window.statsSource = new EventSource("/api/live_stats");
    window.statsSource.addEventListener('message', function(event) {
        var stats = JSON.parse(event.data);
        $('tr[data-pool]').each(function() {
            var pool = stats.pools[$(this).attr('data-pool')];
            if (!pool) return;
            $(this).find('[data-stat="workers"]').text(pool.workerCount);
            $(this).find('[data-stat="validShares"]').text(pool.poolStats.validShares);
            $(this).find('[data-stat="invalidShares"]').text(pool.poolStats.invalidShares);
            $(this).find('[data-stat="hashrate"]').text(pool.hashrateString);
        });
    });

});
