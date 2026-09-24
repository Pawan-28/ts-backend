const http = require("http");

function testBackendKpisEndpoint() {
  const options = {
    hostname: "localhost",
    port: 5000,
    path: "/api/team/kpis?range=today",
    method: "GET",
    headers: {
      "Accept": "application/json"
    }
  };

  const req = http.request(options, (res) => {
    let body = "";
    res.on("data", (chunk) => body += chunk);
    res.on("end", () => {
      console.log("STATUS:", res.statusCode);
      console.log("BODY:", body);
    });
  });

  req.on("error", (err) => console.error("HTTP ERROR:", err));
  req.end();
}

testBackendKpisEndpoint();
