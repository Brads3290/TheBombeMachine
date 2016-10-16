/** The Bombe
 * A suite of tools designed to easily communicate with http://secrethitler.online/
 * Named after the 'Bombe', a machine built by Alan Turing during WWII to help break the German Enigma code.
 * https://en.wikipedia.org/wiki/Bombe
 */

(function () {
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
    //noinspection JSUnusedGlobalSymbols
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

        var URL = self.URL + "socket.io/?EIO=3&transport=polling&t=" + Math.random(); //The URL, including a random UID
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

                console.log("[Bombe Machine - First Contact] Server response code: " + xhrFirstContact.status); //Log the status. Should be 200.
                console.log("[Bombe Machine - First Contact] Server allocated SID: " + JSONResponse["sid"]); //Log the JSON response for debugging.

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

            //noinspection JSUnusedGlobalSymbols
            self.onReceive = function (handler) {
                handlers.incoming[handler_id++] = handler;
            };
            //noinspection JSUnusedGlobalSymbols
            self.onSend = function (handler) {
                handlers.outgoing[handler_id++] = handler;
            };
            //noinspection JSUnusedGlobalSymbols
            self.removeHandler = function (id) {
                //Check for the ID in each of the handler lists and delete accordingly.
                if (handlers.incoming[id]) {
                    delete handlers.incoming[id];
                } else if (handlers.outgoing[id]) {
                    delete handlers.outgoing[id];
                } else { //Otherwiser error
                    throw {e: "[BombeMachine.removeHandler] Invalid ID."};
                }
            };
            self.send = function (data) {
                //If logging is enabled, log.
                if (self.logOutgoing) {
                    console.log("Send: " + data);
                }

                //Send data to server
                self.websocket.send(data);
            };
            self.ping = function (callback) {
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
            self.startAutoPing = function (interval, timeout) {

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
            //noinspection JSUnusedGlobalSymbols
            self.stopAutoPing = function () {
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

    //noinspection JSUnusedGlobalSymbols
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

    //Decide whether to export to the global scope (if in browser) or the module's export (node.js)
    if (_node) {
        module.exports = BombeMachine;
    } else {
        window.BombeMachine = BombeMachine;
    }
}());