import type { RouteOptions } from "fastify";
import {
  createJiraWebhookHandler,
  createJiraWebhookOnRequest,
  type JiraWebhookHandlerOptions,
} from "./jira-webhook-handler.js";

export const JIRA_WEBHOOK_PATH = "/webhooks/jira";

export interface RouteHandlerOptions extends JiraWebhookHandlerOptions {
  secret: string;
}

export type RouteDefinition = Omit<RouteOptions, "url">;

export function createRouteHandlers(options: RouteHandlerOptions): Readonly<Record<string, RouteDefinition>> {
  return {
    [JIRA_WEBHOOK_PATH]: {
      method: "POST",
      onRequest: createJiraWebhookOnRequest(options.secret),
      handler: createJiraWebhookHandler(options),
    },
  };
}
