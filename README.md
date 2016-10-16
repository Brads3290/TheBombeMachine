The Bombe Machine
=================

A small Javascript utility class to allow easy connection and communication with a Secret Hitler server.
It is designed to work with Kyle Coburn's secret-hitler: https://github.com/kylecoburn/secret-hitler.git

Named after Alan Turing's (with a few other contributors) invention, the Bombe, which during World War II assisted in deciphering German communications. 
See https://en.wikipedia.org/wiki/Bombe.


## Installation
    
    npm install thebombemachine --save
    
## Usage
### Instantiation
    var BombeMachine = require("thebombemachine");
    
    var Bombe = new BombeMachine();
    
or

    var Bombe = new BombeMachine(custom_server_URL);
    
### Set up connection
    Bombe.doSetup(callback_function);
    
### Do communications
**The object must have been set up first.**

Handle incoming messages

    var handlerID = Bombe.onReceive(callback_function);

Handle outgoing messages

    var handlerID = Bombe.onSend(callback_function);
Delete event handler (either incoming or outgoing)

    Bombe.removeHandler(handlerID);
Send a message to the server

    Bombe.send(message_string);
Ping the server

    Bombe.ping(callback_function);
Control auto-ping (the server will close the connection if it's not pinged regularly)

    Bombe.startAutoPing(interval_ms [optional], timeout_ms [optional]);
    Bombe.stopAutoPing();
