/**
 * Module dependencies.
 */

var express = require('express');
var path = require('path');
var expressValidator = require('express-validator');
var uuid = require('uuid');
var ent = require('ent');
var cfenv = require('cfenv');

var appEnv = cfenv.getAppEnv();

/**
 * Load controllers.
 */

var homeController = require('./controllers/home');

/**
 * List of random names
 */
var randomNames = require('./config/names');

/**
 * Create Express server & Socket.IO
 */

var app = express();
var http = require('http');
var server = http.createServer(app);
var io = require('socket.io').listen(server);

/**
 * Express configuration.
 */

var hour = 3600000;
var day = (hour * 24);
var week = (day * 7);
var month = (day * 30);

app.set('port', appEnv.port || 3000);
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');
app.use(require('connect-assets')({
	src: 'public',
	helperContext: app.locals
}));
app.use(express.compress());
app.use(express.favicon());
app.use(express.logger('dev'));
app.use(express.cookieParser());
app.use(express.json());
app.use(express.urlencoded());
app.use(expressValidator());
app.use(express.methodOverride());
app.use(app.router);
app.use(express.static(path.join(__dirname, 'public'), { maxAge: week }));
app.use(function(req, res) {
	res.status(404);
	res.render('404');
});
app.use(express.errorHandler());

/**
 * Application routes.
 */

app.get('/', homeController.index);
app.get('/room/:room', homeController.room);

/**
 * Start Express server.
 */

server.listen(app.get('port'), function() {
	console.log("✔ Express server listening on port %d in %s mode", app.get('port'), app.settings.env);
});

/**
* Socket.IO
* ________________________
*/

io.configure(function() {
	io.enable('browser client minification');  // send minified client
	io.enable('browser client etag');          // apply etag caching logic based on version number
	io.enable('browser client gzip');          // gzip the file
	io.set('log level', 1);                    // reduce logging
	io.set('transports', [                     // enable all transports (optional if you want flashsocket)
			'websocket'
		, 'flashsocket'
		, 'htmlfile'
		, 'xhr-polling'
		, 'jsonp-polling'
	]);
});

var people = {};
var rooms = {};
//var currentUserStory = {};

io.sockets.on('connection', function(socket) {
	// We stock socket's id in the people array with "user" as it's name
	people[socket.id] = {"name" : randomNames.names[Math.floor(Math.random() * 49) + 1].name, "room" : undefined};


	/**
	 * Newly connected client
	 */
	//console.log(socket.id+' : Socket connected');
	socket.on('room',function(data){
		var peopleInRoom = {};
		var room = ent.encode(data.room);

		// Join room
		socket.join(room);

		// Set the room of the current client
		people[socket.id].room = room;

		// Check if room id defined
		if (rooms[room] === undefined){
			// If not define it and set it's userStory to undefined
			rooms[room] = {"name" : room, "currentUserStory" : undefined, "cardsRevealed" : false, "lastMessages" : []};
		}

		// Check if client already has a name
		if (data.name !== undefined){
			data.name = ent.encode(data.name.trim());
			if(data.name != ''){
				people[socket.id].name = data.name;
			}
		}
	
		// Display last messages sent 
		rooms[room].lastMessages.forEach(function(data){
			if(data.author == people[socket.id].name){
				socket.emit('message', {msg: data.msg, author : null, me : true, server :  true});
			}else{
				socket.emit('message', {msg: data.msg, author: data.author, me : false, server : true});
			}
		});

 		// Show for each room who is online in it
		io.sockets.clients(room).forEach(function (socket) { 
			peopleInRoom[socket.id] = people[socket.id];
		});


		// Send the list of participants to newly connected socket
		socket.emit('participants', {people: peopleInRoom, id: socket.id});
		// Send the current User Story if one is already here
		if (rooms[room].currentUserStory != undefined) {
		 	socket.emit('newUserStory', rooms[room].currentUserStory);
		}
		// Then broadcast the array in order to list all participants in main.js
		socket.broadcast.to(room).emit('participants', {people: peopleInRoom, connect: people[socket.id].name});
	});


	/**
	 * Client changes his name
	 */
	 socket.on('newName',function(data){
	 	// Check name (not empty, not full of spaces, no XSS)
	 	newName = ent.encode(data.newName.trim());
	 	if(newName != ''){
		 	people[socket.id].name = newName; 
		 	io.sockets.in(data.room).emit('participants', {people: people});
	 	}
	 });

	/**
	 * Client chooses his card
	 */
	 socket.on('cardSelected',function(data){
	 	// Only change card if cards are not revealed yet
 	 	if(rooms[data.room].cardsRevealed === false){
		 	var peopleInRoom = {};

		 	people[socket.id].card = ent.encode(data.card);

			io.sockets.clients(data.room).forEach(function (socket) { 
				peopleInRoom[socket.id] = people[socket.id];
			});

			io.sockets.in(data.room).emit('cardSelected', peopleInRoom);
		}
	 });

	/**
	 * Client changes User Story
	 */

	 socket.on('newUserStory', function(data){
	 	// If the user story is blank, set it to 'User story'
	 	if(data.userStory == ''){
	 		data.userStory = 'User story';
	 	}
	 	rooms[data.room].currentUserStory = ent.encode(data.userStory.trim());
	 	io.sockets.in(data.room).emit('newUserStory', rooms[data.room].currentUserStory);
	 });

	 /**
	 * Reveal cards to all clients
	 */

	 socket.on('revealCards', function(data){
	 	// Only reveal cards if all players chose their's
	 	if(checkCards(data.room) === true){
		 	io.sockets.in(data.room).emit('revealCards');
		 	rooms[data.room].cardsRevealed = true;
	 	}
	 });

	 /**
	 * Play Again
	 */

	 socket.on('playAgain', function(data){
	 	// Only play again if all players chose cards and the cards are revealed
	 	if(checkCards(data.room) === true && rooms[data.room].cardsRevealed === true){
		 	var peopleInRoom = {};

		 	// Set all cards to undefined
		 	io.sockets.clients(data.room).forEach(function (socket) { 
				people[socket.id].card = undefined;
				peopleInRoom[socket.id] = people[socket.id];
			});

			rooms[data.room].cardsRevealed = false;

			io.sockets.in(data.room).emit('playAgain', peopleInRoom);
		}
	 });


	 /**
	 * Send message
	 */

	 socket.on('message', function(data){
	 	var msg = ent.encode(data.msg).trim();

	 	// Save last 10 message on server
	 	var message = {msg: msg, author : people[socket.id].name};
	 	if(rooms[data.room].lastMessages.length < 10){
	 		rooms[data.room].lastMessages.push(message);
	 	}else{
	 		rooms[data.room].lastMessages.shift();
	 		rooms[data.room].lastMessages.push(message);
	 	}

	 	// Only send message if not empty
	 	if(msg != ''){
			socket.broadcast.to(data.room).emit('message', {msg: msg, author: people[socket.id].name});
	 	}
	 });


	/**
	 * Client disconnects
	 */
	// If someones disconnects
	socket.on('disconnect', function() {
		var user = people[socket.id].name;
		var room = people[socket.id].room;
		var peopleInRoom = {};

		// Delete it's reference in the people array
		delete people[socket.id];

		io.sockets.clients(room).forEach(function (socket) { 
			peopleInRoom[socket.id] = people[socket.id];
		});

		// Then broadcast that someone disconnected, with the remaining participants
		socket.broadcast.to(room).emit('participants', {people: peopleInRoom, disconnect: user});
		console.log(socket.id+' : Socket disconnected');
	});
});

/**
* Functions
* ________________________
*/

function checkCards(room){
	var i = 0;
	var cards = 0;

	 io.sockets.clients(room).forEach(function (socket) { 
		if (people[socket.id].card !== undefined){
			cards++;
		}
		i++;
	});

	if (i == cards){
		return true;
	}else{
		return false;
	}
}
