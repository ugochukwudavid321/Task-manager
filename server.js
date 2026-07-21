require("dotenv").config();
require("./gen-vapid");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static("public"));

app.use("/api", require("./butler"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Butler server listening on port ${PORT}`);
});
