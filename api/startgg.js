// ========================================
// ARKDEMIA — Start.gg API Proxy
// Protege o token no servidor
// Endpoint: /api/startgg?slug=tournament/xxx/event/yyy
// ========================================

const https = require("https");

const STARTGG_TOKEN = process.env.STARTGG_TOKEN;

function graphqlRequest(query, variables) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ query, variables });
        const req = https.request({
            hostname: "api.start.gg",
            path: "/gql/alpha",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${STARTGG_TOKEN}`,
                "Content-Length": Buffer.byteLength(body),
            },
        }, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error("Parse error"));
                }
            });
        });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

module.exports = async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (req.method === "OPTIONS") return res.status(200).end();

    const slug = req.query.slug;
    if (!slug) return res.status(400).json({ error: "slug required" });
    if (!STARTGG_TOKEN) return res.status(500).json({ error: "STARTGG_TOKEN not configured" });

    try {
        const result = await graphqlRequest(
            `query($slug: String!) {
                event(slug: $slug) {
                    id name numEntrants
                    standings(query: { perPage: 64, page: 1 }) {
                        nodes { placement entrant { id name } }
                    }
                }
            }`,
            { slug }
        );

        res.setHeader("Cache-Control", "s-maxage=180, stale-while-revalidate=60");
        return res.status(200).json(result);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
