import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";
import crypto from "crypto";
import "dotenv/config";


const app = express();
const port = process.env.PORT || 3000;

console.log("APP_URL:", process.env.APP_URL);
console.log("BEARER_TOKEN exists:", !!process.env.BEARER_TOKEN);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================
   🔁 Retry Utility
========================= */
async function withRetry(fn, retries = 3, delay = 500) {
    try {
        return await fn();
    } catch (err) {
        if (retries === 0) throw err;

        console.error(`Retrying... attempts left: ${retries}`);
        await new Promise(r => setTimeout(r, delay));

        return withRetry(fn, retries - 1, delay * 2);
    }
}

/* =========================
   🌐 OData Call (fetch)
========================= */
async function callOData(path, options = {}) {
    return withRetry(async () => {

         
        const res = await fetch(`${process.env.APP_URL}${path}`, {
            method: options.method || "GET",
            headers: {
                "Authorization": `Bearer ${ process.env.BEARER_TOKEN}`,
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: options.data ? JSON.stringify(options.data) : undefined
        });

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
        }

        return res.json();
    });
}

/* =========================
   🧠 MCP Server + Tools
========================= */
function createServer() {
    const server = new McpServer({
        name: "btp-destination-mcp",
        version: "1.0.0"
    });

    // 1️⃣ list_documents
    server.tool(
        "list_documents",
        "List documents",
        { status: z.string().optional() },
        async ({ status }) => {
            const filter = status ? `?$filter=status eq '${status}'` : "";
            const data = await callOData(`/Documents${filter}`);
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }
    );

    // 2️⃣ get_document
    server.tool(
        "get_document",
        "Get document details",
        { id: z.string() },
        async ({ id }) => {
            const data = await callOData(
                `/Documents(${id})?$expand=ExtractedInvoice,LineItems`
            );
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }
    );

    // 3️⃣ upload_document
    server.tool(
        "upload_document",
        "Upload document",
        { rawText: z.string(), fileName: z.string() },
        async ({ rawText, fileName }) => {
            const data = await callOData(`/uploadDocument`, {
                method: "POST",
                data: { rawText, fileName }
            });
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }
    );

    // 4️⃣ process_document
    server.tool(
        "process_document",
        "Process document",
        { id: z.string() },
        async ({ id }) => {
            const data = await callOData(`/processDocument`, {
                method: "POST",
                data: { id }
            });
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }
    );

    // 5️⃣ get_audit_log
    server.tool(
        "get_audit_log",
        "Get audit logs",
        { documentId: z.string() },
        async ({ documentId }) => {
            const data = await callOData(
                `/AuditLogs?$filter=documentId eq '${documentId}'`
            );
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }
    );

    /* =========================
       📦 Resources
    ========================= */


    return server;
}

/* =========================
   🧩 Session Handling (CRITICAL)
========================= */
const sessions = new Map();

/* =========================
   🌐 Routes
========================= */

app.get("/health", (req, res) => {
    res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

app.get("/", (req, res) => {
    res.json({
        service: "MCP Server",
        endpoints: { mcp: "/mcp (POST)" }
    });
});

/* =========================
   🚀 MCP Endpoint
========================= */
app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] || crypto.randomUUID();

    let session = sessions.get(sessionId);

    if (!session) {
        const server = createServer();

        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => sessionId
        });

        await server.connect(transport);

        session = { server, transport };
        sessions.set(sessionId, session);

        console.log("New session:", sessionId);
    }

    try {
        await session.transport.handleRequest(req, res, req.body);
    } catch (err) {
        console.error("MCP error:", err);
        res.status(500).send("MCP failed");
    }
});

app.listen(port, () => {
    console.log(`🚀 MCP Server running on port ${port}`);
});