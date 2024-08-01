import { handle } from "@hono/node-server/vercel";
import { Hono } from "hono";

import { waitUntil } from "@vercel/functions";

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

app.post("/user/voice", async (c) => {
	const userId = c.var.userId!;
	const messages = (await c.req.json()) as { content: string; role: "user" | "assistant" }[];

	const openai = createOpenAI({
		apiKey: process.env.API_KEY,
		baseURL: process.env.API_URL,
	});

	const { text } = await generateText({
		model: openai("gpt-4o"),
		messages,
	});

	return c.json({ message: text });
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
		messages,
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

app.post("/user/questions/start", async (c) => {
	const userId = c.var.userId!;
	const {
		difficulty,
		subject,
		numOfQuestion = 5,
	} = (await c.req.json()) as {
		difficulty: string;
		subject: string;
		numOfQuestion: number;
	};

	const question = `Give me ${numOfQuestion} questions about ${subject}, all questions must be unique and the level should be ${difficulty}`;

	const openai = createOpenAI({
		apiKey: process.env.API_KEY,
		baseURL: process.env.API_URL,
	});

	const { object } = await generateObject({
		model: openai("gpt-4o"),
		prompt: question,
		temperature: 0.8,
		presencePenalty: 0.02,
		frequencyPenalty: 0.02,
		schema: z.object({
			data: z.array(
				z.object({
					question: z.string(),
					options: z.string().array(),
					answer: z.string(),
				}),
			),
		}),
	});

	const data = await prisma.rank.create({ data: { difficulty, subject, userId } });
	return c.json({ ...object, questionId: data.id });
});

app.post("/user/questions/end", async (c) => {
	const userId = c.var.userId!;
	const { questionId } = (await c.req.json()) as { questionId: string };

	await prisma.rank.update({ where: { id: questionId, userId }, data: { endAt: new Date() } });

	return c.json({ message: "success" });
});

export default handle(app);
