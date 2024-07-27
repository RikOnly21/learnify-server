import { handle } from "@hono/node-server/vercel";
import { Hono } from "hono";

import { createClerkClient } from "@clerk/backend";

import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, generateText } from "ai";

import { PrismaClient } from "@prisma/client";

const prismaClientSingleton = () => {
	return new PrismaClient();
};

declare const globalThis: {
	prismaGlobal: ReturnType<typeof prismaClientSingleton>;
} & typeof global;

const prisma = globalThis.prismaGlobal ?? prismaClientSingleton();
if (process.env.NODE_ENV !== "production") globalThis.prismaGlobal = prisma;

type Env = {
	Variables: {
		userId: string | undefined;
	};
};

export const config = {
	api: {
		bodyParser: false,
	},
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
		apiKey: process.env.API_KEY,
		baseURL: process.env.API_URL,
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

app.post("/user/questions/ask", async (c) => {
	const userId = c.var.userId!;
	const { question } = (await c.req.json()) as { question: string };

	const openai = createOpenAI({
		apiKey: process.env.API_KEY,
		baseURL: process.env.API_URL,
	});

	const { object } = await generateObject({
		model: openai("gpt-4o"),
		prompt: question,
		schema: z.object({
			question: z.string(),
			options: z.string().array(),
			answer: z.string(),
		}),
	});

	return c.json(object);
});

export default handle(app);
