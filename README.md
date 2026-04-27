## Build a Production-Grade MCP Server for CAP

## Overview
  The server exposes a set of MCP tools and resources that let Claude interact with a document processing backend. It uses the MCP SDK with a StreamableHTTPServerTransport, meaning each session is stateful and tracked by a mcp-session-id header.

## Authentication
   The token is never exposed to the client — it lives only in the server process via process.env.BEARER_TOKEN. The MCP endpoint itself (POST /mcp) does not require authentication from Claude's side

## Tool Reference
   list_documents : 
   Lists all documents, with an optional status filter.

   get_document : 
   Retrieves full details for a single document, including its parsed invoice and line items.

   upload_document : 
   Uploads a document as a base64-encoded string to the backend.

   process_document : 
   process_document

   get_audit_log : 
   Returns all audit log entries for a given document.

## Resources
   documents://pending : 
   List of documents with PENDING status

   documents://stats :
   Returns aggregate statistics across all documents:

        Total document count
        Count of DONE documents
        Count of FAILED documents
        Average AI confidence score (from expanded invoice data)

##  Retry Strategy
    All OData calls go through withRetry(), an exponential backoff wrapper:
    Attempt 1 ──► fail ──► wait 500ms
    Attempt 2 ──► fail ──► wait 1000ms
    Attempt 3 ──► fail ──► throw

## Connecting from SAP BTP / Cloud Foundry
   Create an Node.js application.
   npm install
   .env.example .env   # fill in APP_URL and BEARER_TOKEN
   node index.js       # To run the application locally 


## Push to CF
   cf push   # To push the code to CF
   After deploying the application i tested from the POSTMAN.

NOTE  : By using the VScode, I cloned the application and i tested via the official MCP Inspector.
        node index.js       # To run the application locally. 
        For MCP Inspector   # npx @modelcontextprotocol/inspector.

NOTE  : When iam trying to connect the Claude code with my application, It is not working. (It may work with a licensed Claude account).