var events = require('events');
var net = require('net');
var listener = module.exports = function listener(port) {
    var self = this;
    this.start = function() {
        var server = net.createServer(function(socket) {
            var data = '', handled = false;
            socket.setTimeout(5000, function() { socket.destroy(); });
            socket.on('error', function() {});
            socket.on('data', function(chunk) {
                if (handled) return socket.destroy();
                data += chunk.toString('utf8');
                if (Buffer.byteLength(data) > 8192) return socket.destroy();
                var end = data.indexOf('\n');
                if (end < 0) return;
                handled = true;
                try {
                    if (data.slice(end + 1).trim()) throw new Error('Multiple commands');
                    var message = JSON.parse(data.slice(0, end));
                    if (!message || !['blocknotify', 'coinswitch', 'reloadpool'].includes(message.command) ||
                        !Array.isArray(message.params) || message.params.length > 8 ||
                        message.params.some(function(p) { return typeof p !== 'string' || p.length > 256 || /[\r\n\x00]/.test(p); }) ||
                        (message.options != null && (typeof message.options !== 'object' || Array.isArray(message.options))))
                        throw new Error('Invalid command');
                    var options = message.options || {};
                    if (Object.keys(options).some(function(key) {
                        return !['algorithm', 'host', 'port'].includes(key) || typeof options[key] !== 'string' || options[key].length > 256;
                    })) throw new Error('Invalid options');
                    if (!message.params.length || !/^[A-Za-z0-9_-]{1,64}$/.test(message.params[0])) throw new Error('Invalid coin');
                    if (message.command === 'blocknotify' && (message.params.length !== 2 || !/^[a-f0-9]{64}$/i.test(message.params[1])))
                        throw new Error('Invalid block notification');
                    if (message.command === 'reloadpool' && message.params.length !== 1) throw new Error('Invalid pool reload');
                    if (message.command === 'coinswitch' && (message.params.length > 2 ||
                        (message.params[1] && !/^[A-Za-z0-9_-]{1,64}$/.test(message.params[1])) ||
                        (!message.params[1] && !options.algorithm))) throw new Error('Invalid coin switch');
                } catch (_) { socket.end('Invalid CLI request\n'); return; }
                self.emit('command', message.command, message.params, message.options || {}, function(reply) {
                    socket.end(String(reply || ''));
                });
            });
        });
        server.maxConnections = 32;
        server.on('error', function() { self.emit('log', 'CLI listener error'); });
        server.listen(port, '127.0.0.1', function() { self.emit('log', 'CLI listening on loopback'); });
        return server;
    };
};
Object.setPrototypeOf(listener.prototype, events.EventEmitter.prototype);
