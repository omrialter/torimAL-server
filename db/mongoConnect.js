const mongoose = require("mongoose");

// Suppress Mongoose strictQuery warning
// 'false' allows filtering by properties not present in the schema (good for flexibility)
mongoose.set("strictQuery", false);

exports.connectToMongo = async () => {
    // Safety Check: Ensure connection string exists
    if (!process.env.URLDB) {
        throw new Error("Fatal Error: URLDB is not defined in environment variables.");
    }

    try {
        // Connect to the database (Works for both Local & Atlas)
        await mongoose.connect(process.env.URLDB);
    } catch (err) {
        // Propagate error to app.js to handle server shutdown
        throw new Error("MongoDB connection failed: " + err.message);
    }
};