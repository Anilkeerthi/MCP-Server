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


function toMCPResponse(data) {
    const safeData =
        data?.d ||        // OData V2 style
        data?.value ||    // OData V4 collection
        data ||           // normal REST
        {};

    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(safeData)
            }
        ]
    };
}

/* =========================
    Retry Utility
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
    OData Call (fetch)
========================= */
async function callOData(path, options = {}) {
    return withRetry(async () => {

        const res = await fetch(`${process.env.APP_URL}${path}`, {
            method: options.method || "GET",
            headers: {
                "Authorization": `Bearer ${process.env.BEARER_TOKEN}`,
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
    MCP Server + Tools
========================= */
function createServer() {
    const server = new McpServer({
        name: "btp-destination-mcp",
        version: "1.0.0"
    });

    // 1️⃣ list_documents
    server.tool(
        "list_documents",
        "Lists all documents, with an optional status filter.",
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
        "Retrieves full details for a single document, including its parsed invoice and line items",
        { id: z.string() },
        async ({ id }) => {
            const data = await callOData(
                `/Documents(${id})?$expand=invoice($expand=lineItems)`
            );
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }
    );



    server.tool(
        "upload_document",
        "Uploads a document as a base64-encoded string to the backend.",
        { base64: z.string(), fileName: z.string() },
        async ({ base64, fileName }) => {
            try {
                if (!base64) {
                    throw new Error("Base64 content is required");
                }

                console.log("Uploading file:", fileName);

                const response = await callOData(`/uploadDocument`, {
                    method: "POST",
                    data: {
                        rawText: base64,   // ✅ directly pass base64
                        fileName
                    }
                });

                return toMCPResponse(response);

            } catch (err) {
                console.error("Upload Error:", err.message);
                return toMCPResponse({ error: err.message });
            }
        }
    );





    server.tool(
        "process_document",
        "Process document",
        { id: z.string() },
        async ({ id }) => {
            try {
                console.log(" process_document called");
                console.log(" Input ID:", id);

                const response = await callOData(`/processDocument`, {
                    method: "POST",
                    data: {
                        documentId: id
                    }
                });

                console.log("📥 CAP Response:", response);

                return toMCPResponse(response);

            } catch (err) {
                console.error(" Raw Error:", err.message);

                const errorText = err.message || "";

                //  CASE 1: CAP returned "Still processing" but as 500
                if (
                    errorText.includes("Still processing") ||
                    errorText.includes("PROCESS_TIMEOUT")
                ) {
                    console.log("⏳ Document still processing...");

                    return toMCPResponse({
                        status: "PROCESSING",
                        message: "Document is still being processed. Retry after a few seconds.",
                        documentId: id
                    });
                }

                //  CASE 2: Document not found
                if (errorText.includes("Document not found")) {
                    return toMCPResponse({
                        status: "NOT_FOUND",
                        error: "Invalid document ID"
                    });
                }

                //  CASE 3: Document not uploaded to AI
                if (errorText.includes("Document not sent to Document AI")) {
                    return toMCPResponse({
                        status: "INVALID_STATE",
                        error: "Document not yet uploaded to AI"
                    });
                }

                //  CASE 4: Real failure
                console.error(" Unhandled Error:", errorText);

                return toMCPResponse({
                    status: "FAILED",
                    error: errorText
                });
            }
        }
    );

    // 5️⃣ get_audit_log
    server.tool(
        "get_audit_log",
        "Returns all audit log entries for a given document.",
        { documentId: z.string() },
        async ({ documentId }) => {
            const data = await callOData(
                `/AuditLogs?$filter=document_ID  eq '${documentId}'`
            );
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }
    );

    /* =========================
        Resources
    ========================= */

    server.registerResource(
        "Processed (PENDING) Documents",
        "documents://pending",
        {
            title: "Processed Documents",
            description: "List of documents with PENDING status"
        },
        async (uri) => {
            try {
                const filter = encodeURIComponent("status eq 'PENDING'");

                const data = await callOData(
                    `/Documents?$filter=${filter}`
                );

                const docs = data.value || [];

                const formatted = docs.length
                    ? docs.map(d => `
📄 ${d.fileName}
ID: ${d.ID}
Status: ${d.status}
Uploaded By: ${d.uploadedBy || "N/A"}
Uploaded At: ${d.uploadedAt || "N/A"}
`).join("\n-------------------\n")
                    : "No processed (PENDING) documents found";

                return {
                    uri: uri.href,
                    name: "documents-pending",
                    title: "Processed Documents",
                    mimeType: "text/plain",
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: "text/plain",
                            text: formatted.trim()
                        }
                    ]
                };

            } catch (err) {
                return {
                    uri: uri.href,
                    name: "error",
                    mimeType: "text/plain",
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: "text/plain",
                            text: `Error loading documents: ${err.message}`
                        }
                    ]
                };
            }
        }
    );

    server.resource(
        "Document Statistics",
        "documents://stats",
        async () => {
            const data = await callOData(
                `/Documents?$expand=invoice`
            );

            const docs = data.value || [];

            const total = docs.length;

            //  FIXED STATUS VALUES
            const processed = docs.filter(d => d.status === "DONE").length;
            const failed = docs.filter(d => d.status === "FAILED").length;

            const confidences = docs
                .map(d => d.invoice?.confidence)
                .filter(c => typeof c === "number");

            const avgConfidence = confidences.length
                ? (confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(2)
                : "0";

            const summary = `
Document Statistics

Total Documents: ${total}
Processed (DONE): ${processed}
Failed: ${failed}
Average Confidence: ${avgConfidence}
`;

            return {
                contents: [
                    {
                        uri: "documents://stats",
                        text: summary.trim()
                    }
                ]
            };
        }
    );



    return server;
}


const sessions = new Map();

/* =========================
    Routes
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
    MCP Endpoint
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
    console.log(` MCP Server running on port ${port}`);
});