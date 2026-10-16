// The campaign's Firebase Realtime Database. The check-in desk keeps its shared board there (route codes, polls, door counts,
// street names, volunteer names), and the two maps add a line to its sign-in log each time someone unlocks them with the password
// (time, map, device ID, browser, internet address). Never voter data. database.rules.json is the access rules to publish in the
// Firebase console: the desk can read and write its board; the sign-in log can only be added to, and only read in the console.
// Not set up yet: the desk says so and the sign-in log is off. To switch them on, create a Realtime Database, put its URL here,
// e.g. window.DESK_DB = { databaseURL: 'https://<your-project>-default-rtdb.firebaseio.com' };
// and add the same URL to connect-src in the Content-Security-Policy at the top of index.html and polls.html.
window.DESK_DB = null;
