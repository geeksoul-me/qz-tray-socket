var qzConfig = {
    callbackMap: {
        findPrinter:     'qzDoneFinding',
        findPrinters:    'qzDoneFinding',
        appendFile:      'qzDoneAppending',
        appendXML:       'qzDoneAppending',
        appendPDF:       'qzDoneAppending',
        appendImage:     'qzDoneAppending',
        print:           'qzDonePrinting',
        printPS:         'qzDonePrinting',
        printHTML:       'qzDonePrinting',
        printToHost:     'qzDonePrinting',
        printToFile:     'qzDonePrinting',
        findPorts:       'qzDoneFindingPorts',
        openPort:        'qzDoneOpeningPort',
        closePort:       'qzDoneClosingPort',
        findNetworkInfo: 'qzDoneFindingNetwork'
    },
    protocols: ["wss://", "ws://"],   // Protocols to use, will try secure WS before insecure
    uri: "localhost",                // Base URL to server
    ports: [8181, 8282, 8383, 8484], // Ports to try, insecure WS uses port (ports[x] + 1)
    keepAlive: (60 * 1000),           // Interval in millis to send pings to server
    debug: true,

    port: function() { return qzConfig.ports[qzConfig.portIndex] + qzConfig.protocolIndex; },
    protocol: function() { return qzConfig.protocols[qzConfig.protocolIndex]; },
    url: function() { return qzConfig.protocol() + qzConfig.uri + ":" + qzConfig.port(); },
    increment: function() {
        if (++qzConfig.portIndex < qzConfig.ports.length) {
            return true;
        }
        return false;
    },
    outOfBounds: function() { return qzConfig.portIndex >= qzConfig.ports.length },
    init: function(){
        qzConfig.preemptive = {isActive: '', getVersion: '', getPrinter: '', getLogPostScriptFeatures: ''};
        qzConfig.protocolIndex = window.location.protocol == "https:" ? 0 : 1;         // Used to track which value in 'protocol' array is being used
        qzConfig.portIndex = 0;             // Used to track which value in 'ports' array is being used
        return qzConfig;
    }
};

var logger = {
    info: function(v) { console.log(v); },
    log: function(v) { if (qzConfig.debug) { console.log(v); } },
    warn: function(v) { console.warn(v); },
    error: function(v) { console.error(v); }
}

function deployQZ(host, debug) {
    if (host) {
        qzConfig.uri = host;
    }

    if (debug === false) {
        qzConfig.debug = false;
    }

    logger.log(WebSocket);
    qzConfig.init();

    // Old standard of WebSocket used const CLOSED as 2, new standards use const CLOSED as 3, we need the newer standard for jetty
    if ("WebSocket" in window && WebSocket.CLOSED != null && WebSocket.CLOSED > 2) {
        logger.info('Starting deploy of qz');
        connectWebsocket();
    } else {
        alert("WebSocket not supported");
        window["deployQZ"] = null;
    }
}

function connectWebsocket() {
    logger.log('Attempting connection on port ' + qzConfig.port());

    try {
        var websocket = new WebSocket(qzConfig.url());
    }
    catch(e) {
        logger.error(e);
    }

    if (websocket != null) {
        websocket.valid = false;

        websocket.onopen = function(evt) {
            logger.log('Open:');
            logger.log(evt);

            websocket.valid = true;
            connectionSuccess(websocket);

            // Create the QZ object
            createQZ(websocket);

            // Send keep-alive to the websocket so connection does not timeout
            // keep-alive over reconnecting so server is always able to send to client
            websocket.keepAlive = window.setInterval(function() {
                websocket.send("ping");
            }, qzConfig.keepAlive);
        };

        websocket.onclose = function(event) {
            try {
                if (websocket.valid || qzConfig.outOfBounds()) {
                    qzSocketClose(event);
                }
                // Safari compatibility fix to raise error event
                if (!websocket.valid && navigator.userAgent.indexOf('Safari') != -1 && navigator.userAgent.indexOf('Chrome') == -1) {
                    websocket.onerror();
                }
                websocket.cleanup();
            } catch (ignore) {}
        };

        websocket.onerror = function(event) {
            if (websocket.valid || qzConfig.outOfBounds()) {
                qzSocketError(event);
            }

            // Move on to the next port
            if (!websocket.valid) {
                websocket.cleanup();
                if (qzConfig.increment()) {
                    connectWebsocket();
                } else {
                    qzNoConnection();
                }
            }
        };
		
        websocket.cleanup = function() {
            // Explicitly clear setInterval
            if (websocket.keepAlive) {
                window.clearInterval(websocket.keepAlive);        		
            }
            websocket = null;
        };

    } else {
        logger.warn('Websocket connection failed');
        qzNoConnection();
    }
}

// Prototype-safe JSON.stringify
function stringify(o) {
    if (Array.prototype.toJSON) {
        logger.warn("Overriding Array.prototype.toJSON");
        var result = null;
        var tmp = Array.prototype.toJSON;
        delete Array.prototype.toJSON;
        result = JSON.stringify(o);
        Array.prototype.toJSON = tmp;
        return result;
    }
    return JSON.stringify(o);
}

function connectionSuccess(websocket) {
    logger.info('Websocket connection successful');

    websocket.sendObj = function(objMsg) {
        var msg = stringify(objMsg);

        logger.log("Sending " + msg);
        var ws = this;

        // Determine if the message requires signing
        if (objMsg.method === 'listMessages' || Object.keys(qzConfig.preemptive).indexOf(objMsg.method) != -1) {
            ws.send(msg);
        } else {
            signRequest(msg,
                        function(signature) {
                            ws.send(signature + msg);
                        }
            );
        }
    };

    websocket.onmessage = function(evt) {
        var message = JSON.parse(evt.data);

        if (message.error != undefined) {
            logger.error(message.error);
            return;
        }

        // After we ask for the list, the value will come back as a message.
        // That means we have to deal with the listMessages separately from everything else.
        if (message.method == 'listMessages') {
            // Take the list of messages and add them to the qz object
            mapMethods(websocket, message.result);

        } else {
            // Got a return value from a call
            logger.log('Message:');
            logger.log(message);

            if (typeof message.result == 'string') {
                //unescape special characters
                message.result = message.result.replace(/%5C/g, "\\").replace(/%22/g, "\"");

                //ensure boolean strings are read as booleans
                if (message.result == "true" || message.result == "false") {
                    message.result = (message.result == "true");
                }

                if (message.result.substring(0, 1) == '[') {
                    message.result = JSON.parse(message.result);
                }

                //ensure null is read as null
                if (message.result == "null") {
                    message.result = null;
                }
            }

            if (message.callback != 'setupMethods' && message.result != undefined && message.result.constructor !== Array) {
                message.result = [message.result];
            }

            // Special case for getException
            if (message.method == 'getException') {
                if (message.result != null) {
                    var result = message.result;
                    message.result = {
                        getLocalizedMessage: function() {
                            return result;
                        }
                    };
                }
            }

            if (message.callback == 'setupMethods') {
                logger.log("Resetting function call");
                logger.log(message.result);
                qz[message.method] = function() {
                    return message.result;
                }
            }

            if (message.callback != null) {
                try {
                    logger.log("Callbacking: " + message.callback);
                    if (window["qz"][message.callback] != undefined) {
                        window["qz"][message.callback].apply(this, message.init ? [message.method] : message.result);
                    } else {
                        window[message.callback].apply(this, message.result);
                    }
                }
                catch(err) {
                    logger.error(err);
                }
            }
        }

        logger.log("Finished processing message");
    };
}

function createQZ(websocket) {
    // Get list of methods from websocket
    getCertificate(function(cert) {
        websocket.sendObj({method: 'listMessages', params: [cert]});
        window["qz"] = {};
    });
}

function mapMethods(websocket, methods) {
    logger.log('Adding ' + methods.length + ' methods to qz object');
    for(var x = 0; x < methods.length; x++) {
        var name = methods[x].name;
        var returnType = methods[x].returns;
        var numParams = methods[x].parameters;

        // Determine how many parameters there are and create method with that many
        (function(_name, _numParams, _returnType) {
            //create function to map function name to parameter counted function
            window["qz"][_name] = function() {
                var func = undefined;
                if (typeof arguments[arguments.length - 1] == 'function') {
                    func = window["qz"][_name + '_' + (arguments.length - 1)];
                } else {
                    func = window["qz"][_name + '_' + arguments.length];
                }

                func.apply(this, arguments);
            };

            //create parameter counted function to include overloaded java methods in javascript object
            window["qz"][_name + '_' + _numParams] = function() {
                var args = [];
                for(var i = 0; i < _numParams; i++) {
                    args.push(arguments[i]);
                }

                var cb = arguments[arguments.length - 1];
                var cbName = _name + '_callback';

                if ($.isFunction(cb)) {
                    var method = cb.name;

                    // Special case for IE, which does not have function.name property ..
                    if (method == undefined) {
                        method = cb.toString().match(/^function\s*([^\s(]+)/)[1];
                    }

                    if (method == 'setupMethods') {
                        cbName = method;
                    }

                    window["qz"][cbName] = cb;
                } else {
                    logger.log("Using mapped callback " + qzConfig.callbackMap[_name] + "() for " + _name + "()");
                    cbName = qzConfig.callbackMap[_name];
                }

                logger.log("Calling " + _name + "(" + args + ") --> CB: " + cbName + "()");
                websocket.sendObj({method: _name, params: args, callback: cbName, init: (cbName == 'setupMethods')});
            }
        })(name, numParams, returnType);
    }

    // Re-setup all functions with static returns
    for(var key in qzConfig.preemptive) {
        window["qz"][key](setupMethods);
    }

    logger.log("Sent methods off to get rehabilitated");
}

function setupMethods(methodName) {
    if ($.param(qzConfig.preemptive).length > 0) {
        logger.log("Reset " + methodName);
        delete qzConfig.preemptive[methodName];

        logger.log("Methods left to return: " + $.param(qzConfig.preemptive).length);

        // Fire ready method when everything on the QZ object has been added
        if ($.param(qzConfig.preemptive).length == 0) {
            qzReady();
        }
    }
}


function findPrinter (name) {
		    // Get printer name from input box
		    var p = 'zebra';
		    if (name) {
		        p.value = name;
		    }
		
		    if (isLoaded()) {
		        // Searches for locally installed printer with specified name
		        qz.findPrinter("zebra");
		
		        // Automatically gets called when "qz.findPrinter()" is finished.
		        window['qzDoneFinding'] = function() {
		            var p = document.getElementById('printer');
		            var printer = qz.getPrinter();
		
		            // Alert the printer name to user
		            alert(printer !== null ? 'Printer found: "' + printer +
		            '" after searching for "' + p.value + '"' : 'Printer "' +
		            p.value + '" not found.');
		
		            // Remove reference to this function
		            window['qzDoneFinding'] = null;
		        };
		    }
		}

function getCertificate(callback) {
		    /*
		    $.ajax({
		        method: 'GET',
		        url: 'assets/auth/digital-certificate.txt',
		        async: false,
		        success: callback // Data returned from ajax call should be the site certificate
		    });
		    */
		
		    //Non-ajax method, only include public key and intermediate key
		    callback("-----BEGIN CERTIFICATE-----\n" +
		        "MIIFAzCCAuugAwIBAgICEAIwDQYJKoZIhvcNAQEFBQAwgZgxCzAJBgNVBAYTAlVT\n" +
		        "MQswCQYDVQQIDAJOWTEbMBkGA1UECgwSUVogSW5kdXN0cmllcywgTExDMRswGQYD\n" +
		        "VQQLDBJRWiBJbmR1c3RyaWVzLCBMTEMxGTAXBgNVBAMMEHF6aW5kdXN0cmllcy5j\n" +
		        "b20xJzAlBgkqhkiG9w0BCQEWGHN1cHBvcnRAcXppbmR1c3RyaWVzLmNvbTAeFw0x\n" +
		        "NTAzMTkwMjM4NDVaFw0yNTAzMTkwMjM4NDVaMHMxCzAJBgNVBAYTAkFBMRMwEQYD\n" +
		        "VQQIDApTb21lIFN0YXRlMQ0wCwYDVQQKDAREZW1vMQ0wCwYDVQQLDAREZW1vMRIw\n" +
		        "EAYDVQQDDAlsb2NhbGhvc3QxHTAbBgkqhkiG9w0BCQEWDnJvb3RAbG9jYWxob3N0\n" +
		        "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtFzbBDRTDHHmlSVQLqjY\n" +
		        "aoGax7ql3XgRGdhZlNEJPZDs5482ty34J4sI2ZK2yC8YkZ/x+WCSveUgDQIVJ8oK\n" +
		        "D4jtAPxqHnfSr9RAbvB1GQoiYLxhfxEp/+zfB9dBKDTRZR2nJm/mMsavY2DnSzLp\n" +
		        "t7PJOjt3BdtISRtGMRsWmRHRfy882msBxsYug22odnT1OdaJQ54bWJT5iJnceBV2\n" +
		        "1oOqWSg5hU1MupZRxxHbzI61EpTLlxXJQ7YNSwwiDzjaxGrufxc4eZnzGQ1A8h1u\n" +
		        "jTaG84S1MWvG7BfcPLW+sya+PkrQWMOCIgXrQnAsUgqQrgxQ8Ocq3G4X9UvBy5VR\n" +
		        "CwIDAQABo3sweTAJBgNVHRMEAjAAMCwGCWCGSAGG+EIBDQQfFh1PcGVuU1NMIEdl\n" +
		        "bmVyYXRlZCBDZXJ0aWZpY2F0ZTAdBgNVHQ4EFgQUpG420UhvfwAFMr+8vf3pJunQ\n" +
		        "gH4wHwYDVR0jBBgwFoAUkKZQt4TUuepf8gWEE3hF6Kl1VFwwDQYJKoZIhvcNAQEF\n" +
		        "BQADggIBAFXr6G1g7yYVHg6uGfh1nK2jhpKBAOA+OtZQLNHYlBgoAuRRNWdE9/v4\n" +
		        "J/3Jeid2DAyihm2j92qsQJXkyxBgdTLG+ncILlRElXvG7IrOh3tq/TttdzLcMjaR\n" +
		        "8w/AkVDLNL0z35shNXih2F9JlbNRGqbVhC7qZl+V1BITfx6mGc4ayke7C9Hm57X0\n" +
		        "ak/NerAC/QXNs/bF17b+zsUt2ja5NVS8dDSC4JAkM1dD64Y26leYbPybB+FgOxFu\n" +
		        "wou9gFxzwbdGLCGboi0lNLjEysHJBi90KjPUETbzMmoilHNJXw7egIo8yS5eq8RH\n" +
		        "i2lS0GsQjYFMvplNVMATDXUPm9MKpCbZ7IlJ5eekhWqvErddcHbzCuUBkDZ7wX/j\n" +
		        "unk/3DyXdTsSGuZk3/fLEsc4/YTujpAjVXiA1LCooQJ7SmNOpUa66TPz9O7Ufkng\n" +
		        "+CoTSACmnlHdP7U9WLr5TYnmL9eoHwtb0hwENe1oFC5zClJoSX/7DRexSJfB7YBf\n" +
		        "vn6JA2xy4C6PqximyCPisErNp85GUcZfo33Np1aywFv9H+a83rSUcV6kpE/jAZio\n" +
		        "5qLpgIOisArj1HTM6goDWzKhLiR/AeG3IJvgbpr9Gr7uZmfFyQzUjvkJ9cybZRd+\n" +
		        "G8azmpBBotmKsbtbAU/I/LVk8saeXznshOVVpDRYtVnjZeAneso7\n" +
		        "-----END CERTIFICATE-----\n" +
		        "--START INTERMEDIATE CERT--\n" +
		        "-----BEGIN CERTIFICATE-----\n" +
		        "MIIFEjCCA/qgAwIBAgICEAAwDQYJKoZIhvcNAQELBQAwgawxCzAJBgNVBAYTAlVT\n" +
		        "MQswCQYDVQQIDAJOWTESMBAGA1UEBwwJQ2FuYXN0b3RhMRswGQYDVQQKDBJRWiBJ\n" +
		        "bmR1c3RyaWVzLCBMTEMxGzAZBgNVBAsMElFaIEluZHVzdHJpZXMsIExMQzEZMBcG\n" +
		        "A1UEAwwQcXppbmR1c3RyaWVzLmNvbTEnMCUGCSqGSIb3DQEJARYYc3VwcG9ydEBx\n" +
		        "emluZHVzdHJpZXMuY29tMB4XDTE1MDMwMjAwNTAxOFoXDTM1MDMwMjAwNTAxOFow\n" +
		        "gZgxCzAJBgNVBAYTAlVTMQswCQYDVQQIDAJOWTEbMBkGA1UECgwSUVogSW5kdXN0\n" +
		        "cmllcywgTExDMRswGQYDVQQLDBJRWiBJbmR1c3RyaWVzLCBMTEMxGTAXBgNVBAMM\n" +
		        "EHF6aW5kdXN0cmllcy5jb20xJzAlBgkqhkiG9w0BCQEWGHN1cHBvcnRAcXppbmR1\n" +
		        "c3RyaWVzLmNvbTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBANTDgNLU\n" +
		        "iohl/rQoZ2bTMHVEk1mA020LYhgfWjO0+GsLlbg5SvWVFWkv4ZgffuVRXLHrwz1H\n" +
		        "YpMyo+Zh8ksJF9ssJWCwQGO5ciM6dmoryyB0VZHGY1blewdMuxieXP7Kr6XD3GRM\n" +
		        "GAhEwTxjUzI3ksuRunX4IcnRXKYkg5pjs4nLEhXtIZWDLiXPUsyUAEq1U1qdL1AH\n" +
		        "EtdK/L3zLATnhPB6ZiM+HzNG4aAPynSA38fpeeZ4R0tINMpFThwNgGUsxYKsP9kh\n" +
		        "0gxGl8YHL6ZzC7BC8FXIB/0Wteng0+XLAVto56Pyxt7BdxtNVuVNNXgkCi9tMqVX\n" +
		        "xOk3oIvODDt0UoQUZ/umUuoMuOLekYUpZVk4utCqXXlB4mVfS5/zWB6nVxFX8Io1\n" +
		        "9FOiDLTwZVtBmzmeikzb6o1QLp9F2TAvlf8+DIGDOo0DpPQUtOUyLPCh5hBaDGFE\n" +
		        "ZhE56qPCBiQIc4T2klWX/80C5NZnd/tJNxjyUyk7bjdDzhzT10CGRAsqxAnsjvMD\n" +
		        "2KcMf3oXN4PNgyfpbfq2ipxJ1u777Gpbzyf0xoKwH9FYigmqfRH2N2pEdiYawKrX\n" +
		        "6pyXzGM4cvQ5X1Yxf2x/+xdTLdVaLnZgwrdqwFYmDejGAldXlYDl3jbBHVM1v+uY\n" +
		        "5ItGTjk+3vLrxmvGy5XFVG+8fF/xaVfo5TW5AgMBAAGjUDBOMB0GA1UdDgQWBBSQ\n" +
		        "plC3hNS56l/yBYQTeEXoqXVUXDAfBgNVHSMEGDAWgBQDRcZNwPqOqQvagw9BpW0S\n" +
		        "BkOpXjAMBgNVHRMEBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAJIO8SiNr9jpLQ\n" +
		        "eUsFUmbueoxyI5L+P5eV92ceVOJ2tAlBA13vzF1NWlpSlrMmQcVUE/K4D01qtr0k\n" +
		        "gDs6LUHvj2XXLpyEogitbBgipkQpwCTJVfC9bWYBwEotC7Y8mVjjEV7uXAT71GKT\n" +
		        "x8XlB9maf+BTZGgyoulA5pTYJ++7s/xX9gzSWCa+eXGcjguBtYYXaAjjAqFGRAvu\n" +
		        "pz1yrDWcA6H94HeErJKUXBakS0Jm/V33JDuVXY+aZ8EQi2kV82aZbNdXll/R6iGw\n" +
		        "2ur4rDErnHsiphBgZB71C5FD4cdfSONTsYxmPmyUb5T+KLUouxZ9B0Wh28ucc1Lp\n" +
		        "rbO7BnjW\n" +
		        "-----END CERTIFICATE-----\n");
		}
		
		function signRequest(toSign, callback) {
		    /*
		    $.ajax({
		        method: 'GET',
		        contentType: "text/plain",
		        url: '/secure/url/for/sign-message.php?request=' + toSign,
		        async: false,
		        success: callback // Data returned from ajax call should be the signature
		    });
		    */
		
		    //Send unsigned messages to socket - users will then have to Allow/Deny each print request
		    callback();
		}
		
		
		/**
		 * Automatically gets called when applet has loaded.
		 */
		function qzReady() {
		    // If the qz object hasn't been created, fallback on the <applet> tags
		    if (!qz) {
		        window["qz"] = document.getElementById('qz');
		    }
		    var version = document.getElementById("version");
		    if (qz) {
		        try {
		            version.innerHTML = qz.getVersion();
		            document.getElementById("qz-status").style.background = "#F0F0F0";
		        } catch(err) { // LiveConnect error, display a detailed message
		            document.getElementById("qz-status").style.background = "#F5A9A9";
		            alert("ERROR:  \nThe applet did not load correctly.  Communication to the " +
		                    "applet has failed, likely caused by Java Security Settings.  \n\n" +
		                    "CAUSE:  \nJava 7 update 25 and higher block LiveConnect calls " +
		                    "once Oracle has marked that version as outdated, which " +
		                    "is likely the cause.  \n\nSOLUTION:  \n  1. Update Java to the latest " +
		                    "Java version \n          (or)\n  2. Lower the security " +
		                    "settings from the Java Control Panel.");
		        }
		    }
		}
		
		function launchQZ() {
		    if (window["qz"] && $.isFunction(qz.isActive) && qz.isActive()) {
		        alert("Already running");
		    } else {
		        window.location.assign("qz:launch");
		        qzNoConnection = function() { deployQZ(); }
		        qzNoConnection();
		    }
		}
		
		function qzSocketError(event) {
		    document.getElementById("qz-status").style.background = "#F5A9A9";
		    console.log('Error:');
		    console.log(event);
		
		    alert("Connection had an error:\n"+ event.reason);
		}
		
		function qzSocketClose(event) {
		    document.getElementById("qz-status").style.background = "#A0A0A0";
		    console.log('Close:');
		    console.log(event);
		    qz = null;
		
		    alert("Connection was closed:\n"+ event.reason);
		}
		
		function qzNoConnection() {
		    logger.warn("Unable to connect to QZ, is it running?");
		
		    //run deploy applet After page load
		    var content = '';
		    var oldWrite = document.write;
		    document.write = function(text) {
		        content += text;
		    };
		    deployQZApplet();
		
		    var newElem = document.createElement('ins');
		    newElem.innerHTML = content;
		
		    document.write = oldWrite;
		    document.body.appendChild(newElem);
		}
		
		/**
		 * Returns whether or not the applet is not ready to print.
		 * Displays an alert if not ready.
		 */
		function notReady() {
		    // If applet is not loaded, display an error
		    if (!isLoaded()) {
		        return true;
		    }
		    // If a printer hasn't been selected, display a message.
		    else if (!qz.getPrinter()) {
		        alert('Please select a printer first by using the "Detect Printer" button.');
		        return true;
		    }
		    return false;
		}
		
		/**
		 * Returns is the applet is not loaded properly
		 */
		function isLoaded() {
		    if (!qz) {
		        alert('Error:\n\n\tPrint plugin is NOT loaded!');
		        return false;
		    } else {
		        try {
		            if (!qz.isActive()) {
		                alert('Error:\n\n\tPrint plugin is loaded but NOT active!');
		                return false;
		            }
		        } catch (err) {
		            alert('Error:\n\n\tPrint plugin is NOT loaded properly!');
		            return false;
		        }
		    }
		    return true;
		}
		
		/**
		 * Automatically gets called when "qz.print()" is finished.
		 */
		function qzDonePrinting() {
		    // Alert error, if any
		    if (qz.getException()) {
		        alert('Error printing:\n\n\t' + qz.getException().getLocalizedMessage());
		        qz.clearException();
		        return;
		    }
		
		    // Alert success message
		    console.log('Successfully sent print data to "' + qz.getPrinter() + '" queue.');
		}
		
		/***************************************************************************
		 * Prototype function for finding the "default printer" on the system
		 * Usage:
		 *    qz.findPrinter();
		 *    window['qzDoneFinding'] = function() { alert(qz.getPrinter()); };
		 ***************************************************************************/
		function useDefaultPrinter() {
		    if (isLoaded()) {
		        // Searches for default printer
		        qz.findPrinter();
		
		        // Automatically gets called when "qz.findPrinter()" is finished.
		        window['qzDoneFinding'] = function() {
		            // Alert the printer name to user
		            var printer = qz.getPrinter();
		            alert(printer !== null ? 'Default printer found: "' + printer + '"':
		            'Default printer ' + 'not found');
		
		            // Remove reference to this function
		            window['qzDoneFinding'] = null;
		        };
		    }
		}
		
		
		/**
		 * EPCL helper function that appends a single line of EPCL data, taking into
		 * account special EPCL NUL characters, data length, escape character and
		 * carriage return
		 */
		function appendEPCL(data) {
		    if (data == null || data.length == 0) {
		        return alert('Empty EPCL data, skipping!');
		    }
		
		    // Data length for this command, in 2 character Hex (base 16) format
		    var len = (data.length + 2).toString(16);
		    len = len.length < 2 ? '0' + len : len;
		
		    // Append three NULs
		    qz.appendHex('x00x00x00');
		    // Append our command length, in base16 (hex)
		    qz.appendHex('x' + len);
		    // Append our command
		    qz.append(data);
		    // Append carriage return
		    qz.append('\r');
		}


        window["deployQZ"] = deployQZ ;

		deployQZ();


