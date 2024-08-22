import { handle } from "@hono/node-server/vercel";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { trimTrailingSlash } from "hono/trailing-slash";

import { createClerkClient, type ClerkClient } from "@clerk/backend";
import { waitUntil } from "@vercel/functions";

import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { generateObject, generateText } from "ai";
import { z } from "zod";

import { PrismaClient } from "@prisma/client";

const getPrismaClient = () => new PrismaClient();

declare const globalThis: { prismaGlobal: ReturnType<typeof getPrismaClient> } & typeof global;

const prisma = globalThis.prismaGlobal ?? getPrismaClient();
if (process.env.NODE_ENV !== "production") globalThis.prismaGlobal = prisma;

type Env = {
	Variables: {
		userId: string;
		openai: OpenAIProvider;
		clerk: ClerkClient;
	};
};

export const config = { api: { bodyParser: false } };
const app = new Hono<Env>().basePath("/api");

app.use(logger());
app.use(secureHeaders());
app.use(trimTrailingSlash());

app.get("/", (c) => c.json({ message: "Server Working!!!" }));

app.use("/user/*", async (c, next) => {
	const userId = c.req.header()["clerk-user-id"];
	if (!userId) return c.json({ error: { message: "Unauthorized" } }, 401);

	const openai = createOpenAI({ apiKey: process.env.API_KEY, baseURL: process.env.API_URL });
	const clerk = createClerkClient({
		secretKey: process.env.CLERK_SECRET_KEY,
		publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
	});

	const isUserExist = await prisma.user.findUnique({ where: { userId } });
	if (!isUserExist) {
		const user = await clerk.users.getUser(userId).catch(() => null);
		if (!user || user.id !== userId) return c.json({ error: { message: "Unauthorized" } }, 401);

		await prisma.user.create({ data: { name: user.username, userId, imageUrl: user.imageUrl } });
	}

	c.set("userId", userId);
	c.set("openai", openai);
	c.set("clerk", clerk);

	return await next();
});

app.get("/user/messages", async (c) => {
	const userId = c.var.userId;

	const user = await c.var.clerk.users.getUser(userId);
	const messages = await prisma.message.findMany({ where: { userId } });

	return c.json({ user, messages });
});

app.post("/user/voice", async (c) => {
	const messages = (await c.req.json()) as { content: string; role: "user" | "assistant" }[];
	const { text } = await generateText({
		model: c.var.openai("chatgpt-4o-latest"),
		temperature: 0.8,
		presencePenalty: 0.02,
		frequencyPenalty: 0.02,
		messages,
	});

	return c.json({ message: text });
});

app.post("/user/messages/create", async (c) => {
	const userId = c.var.userId;
	const messages = (await c.req.json()) as { content: string; role: "user" | "assistant" }[];

	const system =
		"You're a learning assistant, your name is LearnifyAI. " +
		"Your job is to help user learn english and answer any questions, fix their grammar and spelling mistakes but focus on the main point and question by user. " +
		"Provide the answer in Vietnamese.";

	const { text } = await generateText({
		model: c.var.openai("gpt-4o"),
		temperature: 0.8,
		presencePenalty: 0.02,
		frequencyPenalty: 0.02,
		system,
		messages,
	});

	const saveMessage = async () => {
		const userMessage = messages.pop()!;
		await prisma.message.createMany({
			data: [
				{ content: userMessage.content, role: "USER", userId },
				{ content: text, role: "ASSISTANT", userId },
			],
		});
	};

	waitUntil(saveMessage());
	return c.json({ message: text });
});

app.post("/user/questions/start", async (c) => {
	const userId = c.var.userId;
	const {
		difficulty,
		subject,
		numOfQuestion = 5,
	} = (await c.req.json()) as {
		difficulty: string;
		subject: string;
		numOfQuestion: number;
	};

	const question = `Give me ${numOfQuestion} questions about ${subject}, all questions must be unique and the level should be ${difficulty}, then `;

	const { object } = await generateObject({
		model: c.var.openai("gpt-4o-2024-08-06", { structuredOutputs: true }),
		prompt: question,
		temperature: 0.8,
		presencePenalty: 0.02,
		frequencyPenalty: 0.02,
		schema: z.object({
			data: z.array(
				z.object({
					question: z.string(),
					options: z.string().array().describe("List of options, contain 3 incorrect and 1 correct."),
					answer: z.string().describe("Correct answer for the question."),
					explain: z.string().describe("Explanation why that answer is correct"),
				}),
			),
		}),
	});

	const isExist = await prisma.leaderboard.findFirst({ where: { subject, difficulty, userId } });
	if (!isExist) {
		const data = await prisma.leaderboard.create({ data: { difficulty, subject, userId } });
		return c.json({ ...object, questionId: data.id });
	}

	return c.json({ ...object, questionId: isExist.id });
});

app.post("/user/questions/end", async (c) => {
	const userId = c.var.userId;
	const { questionId, points, startDate, endDate } = (await c.req.json()) as {
		questionId: string;
		points: number;
		startDate: number;
		endDate: number;
	};

	const start = new Date(startDate);
	const end = new Date(endDate);

	const durationInMilliseconds = end.getTime() - start.getTime();
	const durationInSeconds = durationInMilliseconds / 1000;

	const existData = await prisma.leaderboard.findUnique({
		where: { id: questionId, userId },
	});

	if (
		!existData ||
		points > existData.points ||
		(existData.duration && points === existData.points && durationInMilliseconds < existData.duration)
	) {
		await prisma.leaderboard.update({
			where: { id: questionId, userId },
			data: { endAt: end, startAt: start, points, duration: durationInMilliseconds },
		});
	}

	return c.json({ duration: durationInSeconds });
});

app.get("/user/leaderboard/:subject/:difficulty", async (c) => {
	const userId = c.var.userId;
	const { difficulty, subject } = c.req.param();

	const data = (
		await prisma.leaderboard.findMany({
			where: { difficulty, subject },
			orderBy: [{ points: "desc" }, { duration: "asc" }],
			select: { duration: true, points: true, User: { select: { imageUrl: true, name: true, userId: true } } },
			take: 10,
		})
	).map((item) => ({
		...item,
		User: { ...item.User, userId: item.User.userId === userId ? item.User.userId : undefined },
	}));

	const user = await prisma.leaderboard.findUnique({
		where: { userId_subject_difficulty: { userId, difficulty, subject } },
	});

	return c.json({ data, user });
});

app.get("/user/listen", async (c) => {
	const prompt = "Give me a random sentence, that is unique and interesting and easy to listen.";

	const { object } = await generateObject({
		model: c.var.openai("gpt-4o-2024-08-06", { structuredOutputs: true }),
		prompt,
		temperature: 0.8,
		presencePenalty: 0.02,
		frequencyPenalty: 0.02,
		schema: z.object({
			text: z
				.string()
				.describe(
					"A unique sentence. Don't use any special characters/numbers/punctuation and less than 5 words",
				),
		}),
	});

	return c.json({ text: object.text });
});

app.post("/user/fix", async (c) => {
	const { sentence } = (await c.req.json()) as { sentence?: string };
	if (!sentence || sentence.length === 0) return c.json({ error: { message: "Sentence is required" } }, 400);

	const prompt =
		`Fix this sentence: "${sentence}". Use markdown in the explanation, orginal and fixed sentence, underline the place that is wrong.` +
		"If the sentence is correct, just return the sentence. Don't try to improve the sentence.";

	const { object } = await generateObject({
		model: c.var.openai("gpt-4o-2024-08-06", { structuredOutputs: true }),
		prompt,
		temperature: 0.8,
		presencePenalty: 0.02,
		frequencyPenalty: 0.02,
		schema: z.object({
			isCorrect: z.boolean().describe("Is the sentence correct?"),
			orginal: z.string().describe("Original sentence"),
			fixed: z.string().describe("Fixed sentence"),
			explanation: z
				.string()
				.describe("Explain that sentence is wrong and way to fix it, it must be in vietnamese"),
		}),
	});

	return c.json({ ...object });
});

const handler = process.env.NODE_ENV !== "production" ? app : handle(app);

export default handler;
