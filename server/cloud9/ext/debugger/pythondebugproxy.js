/**
 * @copyright 2010, Ajax.org Services B.V.
 * @license GPLv3 <http://www.gnu.org/licenses/gpl.txt>
 */
var net = require("net");
var sys = require("sys");
// TODO: rename NodeSocket. It is not exclusively for node processes
var NodeSocket = require("v8debug/NodeSocket");
var StandalonePythonDebuggerService = require("v8debug/StandalonePythonDebuggerService");

module.exports = DebugProxy = function(port) {
    process.EventEmitter.call(this);
    var _self = this;

    this.connected = false;

    var socket = new NodeSocket("localhost", port);
    socket.onend = function(errorInfo) {
		_self.connected = false;
		_self.emit("end",errorInfo);
    };
	socket.onreceive = function() {
		// TODO: handle failure
        _self.emit("message", JSON.parse(this.receivedText));		
	}
    this.service = new StandalonePythonDebuggerService(socket);

    this.service.addEventListener('connect', function() {
		//console.log("connected");
        _self.connected = true;
        _self.emit("connection");
    });
    this.service.addEventListener('debugger_command_0', function(msg) {
        //console.log("REC ", msg.data);
        _self.emit("message", msg.data);
    });
};

sys.inherits(DebugProxy, process.EventEmitter);

(function() {

    this.connect = function() {
        this.service.attach(0, function() {});
    };

    this.send = function(msgJson) {
        //console.log("SEND " + JSON.stringify(msgJson))
        this.service.debuggerCommand(0, JSON.stringify(msgJson) + "\n");
    };

}).call(DebugProxy.prototype);
