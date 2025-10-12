const indexR = require("./index");
const usersR = require("./users");
const businessesR = require("./businesses");
const appointmentsR = require("./appointments");

exports.routesInit = (app) => {
    app.use("/", indexR);
    app.use("/users", usersR);
    app.use("/businesses", businessesR);
    app.use("/appointments", appointmentsR);


    app.use("*", (req, res) => {
        res.status(404).json({ msg: "page not found 404" });
    });
}

