const express = require("express");
require("dotenv").config();   // 👈 חייב להיות כאן!

console.log("ENV CHECK JWT_SECRET?", Boolean(process.env.JWT_SECRET));
console.log("ENV CHECK TOKENSECRET?", Boolean(process.env.TOKENSECRET));


const http = require("http");
const path = require("path");
const { routesInit } = require("./routes/configRoutes");
const cors = require("cors");

const { connectToMongo } = require("./db/mongoConnect");
const app = express();

(async () => {
    try {
        await connectToMongo();
        console.log("MongoDB connected successfully");
    } catch (err) {
        console.error("Error connecting to MongoDB:", err.message);
        process.exit(1);
    }
})();

app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);

routesInit(app);

let port = process.env.PORT || 3005;
server.listen(port);

console.log("server listening on port " + port);
