/**
 * Debugger Module for the Cloud9 IDE
 *
 * @copyright 2010, Ajax.org B.V.
 * @license GPLv3 <http://www.gnu.org/licenses/gpl.txt>
 */
var Path             = require("path"),
    Spawn            = require("child_process").spawn,
    NodeDebugProxy   = require("./nodedebugproxy"),
    PythonDebugProxy   = require("./pythondebugproxy"),
    ChromeDebugProxy = require("./chromedebugproxy"),
    Plugin           = require("cloud9/plugin"),
    sys              = require("sys"),
    netutil          = require("cloud9/netutil");

var DebuggerPlugin = module.exports = function(ide, workspace) {
    Plugin.call(this, ide, workspace);
    this.hooks = ["command"];
    this.name = "debugger";
    this.nodeCmd = process.argv[0];
	// TODO: change to general python version
	this.pythonCmd = "python2.7"
	this.pythonArgs = ["-u"]
};

sys.inherits(DebuggerPlugin, Plugin);

(function() {
    this.DEBUG_PORT = 5858;
    this.CHROME_DEBUG_PORT = 9222;

    this.init = function() {
        var _self = this;
        this.workspace.getExt("state").on("statechange", function(state) {
            state.debugClient = !!_self.debugClient;
            state.processRunning = !!_self.child;
        });
    };

    this.command = function(user, message, client) {
        var _self = this;

        var cmd = (message.command || "").toLowerCase(),
            res = true;
        switch (cmd) {
            case "run":
				this.$run(message, client);
                break;
            case "rundebug":
                netutil.findFreePort(this.DEBUG_PORT, "localhost", function(port) {
                    _self.DEBUG_PORT = port;
					
					// set debugger arguments based on runner
					// TODO: the business logic of executing the debugger should not be here
					if ( message.runner == "js" )
						message.preArgs = ["--debug=" + _self.DEBUG_PORT];
					else if ( message.runner == "py" )
						// TODO: forward slash ("\") for windows?
						message.preArgs = [process.env.PWD + "/rpdb.py","--port", _self.DEBUG_PORT];
						
					message.debug = true;
					// in parallel (both operations translate to async processes):
					// * execute a node process that executes the source file (with debug)
					// * start a debug proxy process to handle communication with the debugger.
					//   note: the debug proxy has a builtin retry functionality, this will
					//         resolve incidents when the debugger is not ready yet for the
					//		   proxy
					_self.$run(message, client);
					_self.$startDebug(message);
                });
                break;
            case "rundebugbrk":
                netutil.findFreePort(this.DEBUG_PORT, "localhost", function(port) {
					_self.DEBUG_PORT = port;

					// set debugger arguments based on runner
					// TODO: the business logic of executing the debugger should not be here
					if ( message.runner == "js" )
						message.preArgs = ["--debug-brk=" + _self.DEBUG_PORT];
					else if ( message.runner == "py" )
						message.preArgs = [process.env.PWD + "/rpdb.py","--port", _self.DEBUG_PORT];
						
					message.debug = true;
					// in parallel (both operations translate to async processes):
					// * execute a node process that executes the source file (with debug)
					// * start a debug proxy process to handle communication with the debugger.
					//   note: the debug proxy has a builtin retry functionality, this will
					//         resolve incidents when the debugger is not ready yet for the
					//		   proxy
					_self.$run(message, client);
					_self.$startDebug(message);
                });
                break;
            case "rundebugchrome":
                if (this.chromeDebugProxy) {
                    this.error("Chrome debugger already running!", 7, message);
                    break;
                }
                this.chromeDebugProxy = new ChromeDebugProxy(this.CHROME_DEBUG_PORT);
                this.chromeDebugProxy.connect();

                this.chromeDebugProxy.addEventListener("connection", function() {
                    _self.send({"type": "chrome-debug-ready"}, null, _self.name);
                });
                break;
            case "debugnode":
                if (!this.debugProxy)
                    this.error("No debug session running!", 6, message);
                else
                    this.debugProxy.send(message.body);
                break;
            case "debugattachnode":
                if (this.debugProxy)
                    this.send({"type": "node-debug-ready"}, null, _self.name);
                break;
            case "kill":
                this.$kill();
                break;
            default:
                res = false;
                break;
        }
        return res;
    };

    this.$kill = function() {
        var child = this.child;
        if (!child)
            return;
        try {
            child.kill();
            // check after 2sec if the process is really dead
            // If not kill it harder
            setTimeout(function() {
                if (child.pid > 0)
                    child.kill("SIGKILL");
            }, 2000)
        }
        catch(e) {}
    };

    this.$run = function(message, client) {
        var _self = this;

        if (this.child)
            return _self.error("Child process already running!", 1, message);

        var file = _self.workspace.workspaceDir + "/" + message.file;

        Path.exists(file, function(exists) {
           if (!exists)
               return _self.error("File does not exist: " + message.file, 2, message);

           var cwd = _self.workspace.workspaceDir + "/" + (message.cwd || "");
           Path.exists(cwd, function(exists) {
               if (!exists)
                   return _self.error("cwd does not exist: " + message.cwd, 3, message);
                // lets check what we need to run
				
				// set process arguments based on runner
				// TODO: the business logic of executing the debugger should not be here
				if ( message.runner == "js" )
				{
                   var args = (message.preArgs || []).concat(file).concat(message.args || []);
                   _self.$runProc(_self.nodeCmd, args, cwd, message.env || {}, message.debug || false);
                } 
				else if ( message.runner == "py" )
				{
                   var args = _self.pythonArgs.concat(message.preArgs || []).concat(file).concat(message.args || []);
                   _self.$runProc(_self.pythonCmd, args, cwd, message.env || {}, message.debug || false);
				}
				else {
                   _self.$runProc(file, message.args||[], cwd, message.env || {}, false);
                }
           });
        });
    };

    this.$runProc = function(proc, args, cwd, env, debug) {
        var _self = this;
        var name = this.name;

        // mixin process env
        for (var key in process.env) {
            if (!(key in env))
                env[key] = process.env[key];
        }
				
        console.log("Executing process "+proc+" "+args.join(" ")+" "+cwd);

        var child = _self.child = Spawn(proc, args, {cwd: cwd, env: env});
        //_self.debugClient = args.join(" ").search(/(?:^|\b)\-\-debug\b/) != -1;
		// set the value of the debugClient state according if:
		//     process to-be-executed is a debug process
		_self.debugClient = debug || false
        _self.workspace.getExt("state").publishState();
		// TODO: rename? it can also be python
        _self.send({"type": "node-start"}, null, name);

        child.stdout.on("data", sender("stdout"));
        child.stderr.on("data", sender("stderr"));

        function sender(stream) {
            return function(data) {
                var message = {
					// TODO: rename? it can also be python
                    "type": "node-data",
                    "stream": stream,
                    "data": data.toString("utf8")
                };
                _self.send(message, null, name);
            };
        }

        child.on("exit", function(code) {
			// TODO: rename? it can also be python
            _self.send({"type": "node-exit"}, null, name);

            _self.debugClient = false;
            delete _self.child;
            delete _self.debugProxy;
        });

        return child;
    };

    this.$startDebug = function(message) {
        var _self = this;
		
		/*
		// this is not a good test, because:
		// 1. the startDebug function is only used together with execution of
		//	  debug process
		// 2. the value of this.debugClient is changed upon events, thus
		//	  making this inspection suseptible to race condition
        if (!this.debugClient)
            return this.error("No debuggable application running", 4, message);
		*/

        if (this.debugProxy)
            return this.error("Debug session already running", 5, message);
			
		if ( message.runner == "js" )
			this.debugProxy = new NodeDebugProxy(this.DEBUG_PORT);
		else if ( message.runner == "py" )
			this.debugProxy = new PythonDebugProxy(this.DEBUG_PORT);
        this.debugProxy.on("message", function(body) {
				
            var msg = {
                "type": "node-debug",
                "body": body
            };
            _self.send(msg, null, _self.name);
        });
		
        this.debugProxy.on("connection", function() {
            _self.send({"type": "node-debug-ready"}, null, _self.name);
        });

        this.debugProxy.on("end", function(errorInfo) {
			// incase an error occured, send a message back to the client
			if ( ( errorInfo != undefined ) && ( errorInfo != null ) )		
			{
				// TODO: errorInfo should be an exception instance with more fields
				// TODO: in this case the debugger process is still running.
				//	     we need to kill that process, while not interfering with other
				//	     parts of the source.
				//		 Also, the idea is that if the "node-exit-with-error" event
				//	     is dispatched, than the "node-exit" event is not.
				// TODO: in theory a "node-start" event might be sent after this event (though
				//       extremely unlikely. Deal with all this event mess
				_self.send({"type": "node-exit-with-error",errorMessage:errorInfo}, null, _self.name);
				_self.debugClient = false;
				delete _self.child;
				delete _self.debugProxy;				
			}
				
            if (_self.debugProxy == this) {
                delete _self.debugProxy;
            }
        });

        this.debugProxy.connect();
    };

    this.dispose = function(callback) {
        this.$kill();
        callback();
    };

}).call(DebuggerPlugin.prototype);
