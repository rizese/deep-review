/**
 * The server's wire types, for clients. Everything here is a type: a client
 * imports this file for the shapes `/prs`, `/events` and `/prs/:key/input`
 * answer with, and none of the server's runtime comes along.
 */
export type { PrFacts, PrFailure, PrKey, PrRole, PrState, PrView, RegistryEvent, RetryPolicy } from "./registry.js";
export type { SliceExplorerInput } from "@deep-review/call-graph";
