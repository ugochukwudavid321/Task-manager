require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "Butler backend is running" });
});

app.use("/api", require("./routes/butler"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Butler server listening on port ${PORT}`);
});
