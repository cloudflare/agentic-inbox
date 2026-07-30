// Validate the deployment-ready configuration emitted by the Cloudflare Vite
// plugin. Source wrangler.jsonc assertions alone can miss environment-resolution
// mistakes, so this script inspects the exact artifact Wrangler will deploy.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPrivateOperationLogger } from "./private-operation-logger.mjs";

export const REQUIRED_SECRETS = [
	"ACCOUNT_RECOVERY_DIRECTORY",
	"ADMIN_BOOTSTRAP_EMAIL",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"CREDENTIAL_RECOVERY_PAYLOAD_KEY_V1",
	"JWT_SECRET",
	"SES_EVENT_WEBHOOK_SECRET",
	"VAPID_PRIVATE_KEY",
	"VAPID_PUBLIC_KEY",
];

const CRONS = ["* * * * *", "*/5 * * * *", "17 * * * *"];
const COMPATIBILITY_DATE = "2025-11-28";
const GENERATED_MODULE_RULES = [
	{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] },
];

const ENVIRONMENTS = {
	whispyr: {
		name: "sales-mail-portal",
		brand: "whispyr",
		domains: "whispyrcrm.com",
		features: ["quiz"],
		databaseName: "sales_portal_users",
		databaseId: "f322fd13-dc49-4390-888c-ff862ca05882",
		attachmentBucket: "sales-mail-portal",
		attachmentPreviewBucket: "sales-mail-portal-preview",
		rawBucket: "sales-mail-raw-archive",
		rawPreviewBucket: "sales-mail-raw-archive-preview",
		inboundQueue: "sales-mail-inbound",
		inboundDlq: "sales-mail-inbound-dlq",
		inboundParking: "sales-mail-inbound-parking",
		emergencyQueue: "sales-mail-emergency-forward",
		emergencyParking: "sales-mail-emergency-forward-parking",
		emergencyFrom: "emergency-forward@whispyrcrm.com",
		kvId: "cd541026bdf949d9ac63b3b5fdff4969",
		route: "mail.whispyrcrm.com",
		forbidden: [
			"wiser-mail-portal",
			"wiser-mail-portal-preview",
			"wiser_mail_portal_users",
			"87c3de98-d31b-4ec3-8e05-d26b4dc71d92",
			"c934d803c2f8430d9088f4a5d9f29d55",
			"wiser-mail-raw-archive",
			"wiser-mail-inbound",
			"wiser-mail-emergency-forward",
			"emergency-forward@wiserchat.ai",
			"wiserchat.ai",
		],
	},
	wiser: {
		name: "wiser-mail-portal",
		brand: "wiser",
		domains: "wiserchat.ai",
		features: [],
		databaseName: "wiser_mail_portal_users",
		databaseId: "87c3de98-d31b-4ec3-8e05-d26b4dc71d92",
		attachmentBucket: "wiser-mail-portal",
		attachmentPreviewBucket: "wiser-mail-portal-preview",
		rawBucket: "wiser-mail-raw-archive",
		rawPreviewBucket: "wiser-mail-raw-archive-preview",
		inboundQueue: "wiser-mail-inbound",
		inboundDlq: "wiser-mail-inbound-dlq",
		inboundParking: "wiser-mail-inbound-parking",
		emergencyQueue: "wiser-mail-emergency-forward",
		emergencyParking: "wiser-mail-emergency-forward-parking",
		emergencyFrom: "emergency-forward@wiserchat.ai",
		kvId: "c934d803c2f8430d9088f4a5d9f29d55",
		route: "mail.wiserchat.ai",
		forbidden: [
			"sales-mail-portal",
			"sales-mail-portal-preview",
			"sales_portal_users",
			"f322fd13-dc49-4390-888c-ff862ca05882",
			"cd541026bdf949d9ac63b3b5fdff4969",
			"sales-mail-raw-archive",
			"sales-mail-inbound",
			"sales-mail-emergency-forward",
			"emergency-forward@whispyrcrm.com",
			"whispyrcrm.com",
			"test.wiserchat.ai",
		],
	},
};

const EMPTY_RESOURCE_COLLECTIONS = [
	"analytics_engine_datasets",
	"containers",
	"dispatch_namespaces",
	"hyperdrive",
	"mtls_certificates",
	"pipelines",
	"ratelimits",
	"secrets_store_secrets",
	"services",
	"tail_consumers",
	"unsafe_hello_world",
	"vectorize",
	"vpc_services",
	"worker_loaders",
	"workflows",
];

const FORBIDDEN_RESOURCE_OBJECTS = ["browser", "images", "version_metadata"];

function defaultLogFilePath(brand, now = new Date()) {
	const timestamp = now.toISOString().replace(/[:.]/g, "-");
	const suffix = randomBytes(6).toString("hex");
	return resolve(
		"script-logs",
		`verify-built-environment-${brand || "unknown"}-${timestamp}-${process.pid}-${suffix}.log`,
	);
}

async function createLogger({ brand, logFilePath, stdout, stderr }) {
	const resolvedLogFilePath = resolve(logFilePath ?? defaultLogFilePath(brand));
	return createPrivateOperationLogger({
		logFilePath: resolvedLogFilePath,
		header: `verify-built-environment\nbrand=${brand || "<missing>"}\nstarted_at=${new Date().toISOString()}`,
		stdout,
		stderr,
	});
}

async function checkEqual(logger, actual, expected, label) {
	await logger.detail(
		`${label}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
	);
	assert.deepEqual(actual, expected, label);
}

function expectedQueueTopology(expected) {
	return {
		producers: [
			{ binding: "INBOUND_QUEUE", queue: expected.inboundQueue },
			{ binding: "EMERGENCY_FORWARD_QUEUE", queue: expected.emergencyQueue },
		],
		consumers: [
			{
				queue: expected.inboundQueue,
				max_batch_size: 1,
				max_concurrency: 1,
				max_batch_timeout: 5,
				max_retries: 10,
				retry_delay: 1,
				dead_letter_queue: expected.inboundDlq,
			},
			{
				queue: expected.inboundDlq,
				max_batch_size: 1,
				max_concurrency: 1,
				max_batch_timeout: 5,
				max_retries: 10,
				retry_delay: 60,
				dead_letter_queue: expected.inboundParking,
			},
			{
				queue: expected.inboundParking,
				max_batch_size: 1,
				max_concurrency: 1,
				max_batch_timeout: 5,
				max_retries: 100,
				retry_delay: 3600,
			},
			{
				queue: expected.emergencyQueue,
				max_batch_size: 1,
				max_concurrency: 1,
				max_batch_timeout: 5,
				max_retries: 10,
				retry_delay: 300,
				dead_letter_queue: expected.emergencyParking,
			},
			{
				queue: expected.emergencyParking,
				max_batch_size: 1,
				max_concurrency: 1,
				max_batch_timeout: 5,
				max_retries: 100,
				retry_delay: 3600,
			},
		],
	};
}

export async function verifyBuiltEnvironment({
	brand,
	artifactPath = "build/server/wrangler.json",
	logFilePath,
	stdout = console.log,
	stderr = console.error,
}) {
	const logger = await createLogger({ brand, logFilePath, stdout, stderr });

	try {
		await logger.progress(
			`Verifying ${brand || "unspecified"} deployment artifact`,
		);
		await logger.progress(`Detailed log: ${logger.logFilePath}`);

		const expected = ENVIRONMENTS[brand];
		assert.ok(
			expected,
			`brand must be one of: ${Object.keys(ENVIRONMENTS).join(", ")}`,
		);

		await logger.progress("Phase 1/4: reading resolved Worker configuration");
		const resolvedArtifactPath = resolve(artifactPath);
		const config = JSON.parse(await readFile(resolvedArtifactPath, "utf8"));
		await logger.detail(`artifact_path=${resolvedArtifactPath}`);
		await logger.detail(`resolved_configuration=${JSON.stringify(config)}`);

		await logger.progress("Phase 2/4: checking identity and exact bindings");
		await checkEqual(logger, config.main, "index.js", "generated main module");
		await checkEqual(
			logger,
			config.rules,
			GENERATED_MODULE_RULES,
			"generated module rules",
		);
		await checkEqual(logger, config.no_bundle, true, "generated no_bundle shape");
		await checkEqual(
			logger,
			config.compatibility_date,
			COMPATIBILITY_DATE,
			"compatibility_date",
		);
		await checkEqual(
			logger,
			config.observability,
			{ enabled: true },
			"observability",
		);
		await checkEqual(logger, config.name, expected.name, "Worker name");
		await checkEqual(logger, config.vars?.BRAND, expected.brand, "BRAND");
		await checkEqual(logger, config.vars?.DOMAINS, expected.domains, "DOMAINS");
		await checkEqual(logger, config.vars?.FEATURES, expected.features, "FEATURES");
		await checkEqual(
			logger,
			config.vars?.AWS_REGION,
			"eu-west-2",
			"AWS_REGION",
		);
		await checkEqual(
			logger,
			config.vars?.SES_CONFIGURATION_SET,
			"mail-portal-events",
			"SES_CONFIGURATION_SET",
		);
		await checkEqual(
			logger,
			config.vars?.INBOUND_QUEUE_NAME,
			expected.inboundQueue,
			"INBOUND_QUEUE_NAME",
		);
		await checkEqual(
			logger,
			config.vars?.INBOUND_DLQ_NAME,
			expected.inboundDlq,
			"INBOUND_DLQ_NAME",
		);
		await checkEqual(
			logger,
			config.vars?.INBOUND_PARKING_NAME,
			expected.inboundParking,
			"INBOUND_PARKING_NAME",
		);
		await checkEqual(
			logger,
			config.vars?.EMERGENCY_FORWARD_QUEUE_NAME,
			expected.emergencyQueue,
			"EMERGENCY_FORWARD_QUEUE_NAME",
		);
		await checkEqual(
			logger,
			config.vars?.EMERGENCY_FORWARD_PARKING_NAME,
			expected.emergencyParking,
			"EMERGENCY_FORWARD_PARKING_NAME",
		);
		await checkEqual(
			logger,
			config.vars?.EMERGENCY_FORWARD_FROM,
			expected.emergencyFrom,
			"EMERGENCY_FORWARD_FROM",
		);
		await checkEqual(
			logger,
			config.vars?.EMERGENCY_FORWARD_DESTINATION,
			"heshamelmahdi@gmail.com",
			"EMERGENCY_FORWARD_DESTINATION",
		);
		await checkEqual(
			logger,
			[...(config.secrets?.required ?? [])].sort(),
			REQUIRED_SECRETS,
			"required secrets",
		);
		await checkEqual(
			logger,
			config.routes,
			[{ pattern: expected.route, custom_domain: true }],
			"custom-domain routes",
		);
		await checkEqual(
			logger,
			config.d1_databases,
			[
				{
					binding: "DB",
					database_name: expected.databaseName,
					database_id: expected.databaseId,
					migrations_dir: "migrations",
				},
			],
			"D1 bindings",
		);
		assert.notEqual(
			config.r2_buckets?.[0]?.bucket_name,
			config.r2_buckets?.[0]?.preview_bucket_name,
			"attachment R2 preview bucket must be isolated from production",
		);
		assert.notEqual(
			config.r2_buckets?.[1]?.bucket_name,
			config.r2_buckets?.[1]?.preview_bucket_name,
			"raw R2 preview bucket must be isolated from production",
		);
		await checkEqual(
			logger,
			config.r2_buckets,
			[
				{
					binding: "BUCKET",
					bucket_name: expected.attachmentBucket,
					preview_bucket_name: expected.attachmentPreviewBucket,
				},
				{
					binding: "RAW_MAIL_BUCKET",
					bucket_name: expected.rawBucket,
					preview_bucket_name: expected.rawPreviewBucket,
				},
			],
			"R2 bindings",
		);
		await checkEqual(
			logger,
			config.send_email,
			[
				{
					name: "EMERGENCY_EMAIL",
					destination_address: "heshamelmahdi@gmail.com",
					allowed_sender_addresses: [expected.emergencyFrom],
				},
			],
			"fixed emergency Email Service binding",
		);
		await checkEqual(
			logger,
			config.kv_namespaces,
			[{ binding: "OAUTH_KV", id: expected.kvId }],
			"KV bindings",
		);
		await checkEqual(logger, config.ai, { binding: "AI" }, "Workers AI binding");
		await checkEqual(
			logger,
			config.durable_objects?.bindings,
			[
				{ name: "MAILBOX", class_name: "MailboxDO" },
				{ name: "EMAIL_AGENT", class_name: "EmailAgent" },
				{ name: "EMAIL_MCP", class_name: "EmailMCP" },
			],
			"Durable Object bindings",
		);

		await logger.progress("Phase 3/4: checking Queue and schedule topology");
		await checkEqual(
			logger,
			config.queues,
			expectedQueueTopology(expected),
			"Queue graph and consumer settings",
		);
		await checkEqual(logger, config.triggers?.crons, CRONS, "Cron schedules");

		await logger.progress("Phase 4/4: checking extra resources and brand isolation");
		for (const collection of EMPTY_RESOURCE_COLLECTIONS) {
			if (collection in config) {
				await checkEqual(logger, config[collection], [], `${collection} resources`);
			}
		}
		for (const resource of FORBIDDEN_RESOURCE_OBJECTS) {
			await checkEqual(logger, config[resource], undefined, `${resource} resource`);
		}
		if (config.unsafe) {
			await checkEqual(
				logger,
				config.unsafe.bindings ?? [],
				[],
				"unsafe bindings",
			);
		}
		if (config.logfwdr) {
			await checkEqual(logger, config.logfwdr.bindings ?? [], [], "logfwdr bindings");
		}
		if (config.cloudchamber) {
			await checkEqual(logger, config.cloudchamber, {}, "Cloudchamber resources");
		}

		const serialized = JSON.stringify(config);
		for (const forbidden of expected.forbidden) {
			const present = serialized.includes(forbidden);
			await logger.detail(`forbidden_identifier=${forbidden} present=${present}`);
			assert.equal(
				present,
				false,
				`${brand} artifact leaked forbidden identifier ${forbidden}`,
			);
		}

		await logger.progress(`${brand} built environment is isolated and valid`);
		return { logFilePath: logger.logFilePath };
	} catch (error) {
		const message =
			error instanceof Error ? (error.stack ?? error.message) : String(error);
		await logger.detail(`FAILED: ${message}`);
		await logger.failure(
			`${brand || "Environment"} built environment verification failed. See ${logger.logFilePath}`,
		);
		throw error;
	} finally {
		await logger.close();
	}
}

function parseArguments(argv) {
	const [brand, ...options] = argv;
	let artifactPath = "build/server/wrangler.json";
	let logFilePath;

	for (let index = 0; index < options.length; index += 1) {
		const option = options[index];
		const value = options[index + 1];
		if (option === "--artifact" && value) {
			artifactPath = value;
			index += 1;
			continue;
		}
		if (option === "--log" && value) {
			logFilePath = value;
			index += 1;
			continue;
		}
		throw new Error(`Unknown or incomplete option: ${option}`);
	}

	return { artifactPath, brand, logFilePath };
}

const isDirectInvocation =
	process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectInvocation) {
	try {
		await verifyBuiltEnvironment(parseArguments(process.argv.slice(2)));
	} catch {
		process.exitCode = 1;
	}
}
