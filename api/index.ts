import { Hono } from "hono";
import { handle } from "hono/vercel";

import { createClerkClient } from "@clerk/backend";

import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

import { prisma } from "./db";
type Env = {
	Variables: {
		userId: string | undefined;
	};
};

export const config = {
	runtime: "edge",
};

const app = new Hono<Env>().basePath("/api");

app.get("/", (c) => c.json({ message: "test" }));

app.use("/user/*", async (c, next) => {
	const userId = c.req.header()["clerk-user-id"];
	if (!userId) return c.json({ error: { message: "Unauthorized" } }, 401);

	c.set("userId", userId);
	return await next();
});

app.get("/user/messages", async (c) => {
	const userId = c.var.userId!;

	const client = createClerkClient({
		secretKey: process.env["CLERK_SECRET_KEY"],
		publishableKey: process.env["CLERK_PUBLISHABLE_KEY"],
	});

	const user = await client.users.getUser(userId);
	const messages = await prisma.message.findMany({ where: { userId } });

	return c.json({ user, messages });
});

app.post("/user/messages/create", async (c) => {
	const userId = c.var.userId!;
	const messages = (await c.req.json()) as { content: string; role: "user" | "assistant" }[];

	const openai = createOpenAI({
		apiKey: "8d2bcf76-25d6-455b-bd7f-03eebe4848cb",
		baseURL: "https://guujiyae.me/proxy/openai",
	});

	const { text } = await generateText({
		model: openai("gpt-4o"),
		messages: messages,
	});

	const userMessage = messages.pop()!;
	await prisma.message.createMany({
		data: [
			{ content: userMessage.content, role: "USER", userId },
			{ content: text, role: "AI", userId },
		],
	});

	return c.json({ message: text });
});

export default handle(app);
