function showLogin() { $('#adminCenter').hide(); $('#passwordForm').show(); }
function apiRequest(method, data, callback) {
    var request = new XMLHttpRequest();
    request.open('POST', '/api/admin/' + method);
    request.setRequestHeader('Content-Type', 'application/json');
    request.setRequestHeader('X-Admin-Request', '1');
    request.onload = function() {
        if (request.status !== 200) { showLogin(); return; }
        callback(JSON.parse(request.responseText));
    };
    request.send(JSON.stringify(data));
}
function tryLogin() {
    apiRequest('pools', {}, function(response) {
        $('#passwordForm').hide(); $('#adminCenter').show();
        $('.poolMenuItem').remove();
        Object.keys(response.result).forEach(function(name) {
            var item = $('<li>').addClass('poolMenuItem');
            item.append($('<a>').attr('href', '#').text(name));
            $('#poolList').after(item);
        });
    });
}
// Remove the legacy plaintext credential cookie on migration.
document.cookie = 'password=; Max-Age=0; Path=/';
document.cookie = 'password=; Max-Age=0';
$('#passwordForm').submit(function(event) {
    event.preventDefault();
    var password = $('#password').val();
    $('#password').val('');
    apiRequest('login', {password: password}, tryLogin);
    return false;
});
tryLogin();
