import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
};

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const DRIVE_FILENAME = Deno.env.get("DRIVE_DATA_FILENAME") ?? "qa-testcases-data.json";
const DRIVE_DATA_FILE_ID = Deno.env.get("DRIVE_DATA_FILE_ID")?.trim() ?? "";
const DEFAULT_DB = {
  version: 1,
  status: {},
  customFeatures: [],
  customCases: {},
  deletedCases: [],
};

let cachedGoogleToken: { value: string; expiresAt: number } | null = null;

type ServiceAccountConfig = {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function mustGetEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function getDriveSharedFolderId() {
  const value = mustGetEnv("DRIVE_SHARED_FOLDER_ID").trim();
  if ([".", "/", "YOUR_GOOGLE_DRIVE_FOLDER_ID", "YOUR_FOLDER_ID"].includes(value)) {
    throw new Error(
      `Invalid DRIVE_SHARED_FOLDER_ID: "${value}". Please set it to the real Google Drive folder id.`,
    );
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeDb(value: unknown) {
  const data = isPlainObject(value) ? value : {};
  return {
    version: typeof data.version === "number" ? data.version : 1,
    status: isPlainObject(data.status) ? data.status : {},
    customFeatures: Array.isArray(data.customFeatures) ? data.customFeatures : [],
    customCases: isPlainObject(data.customCases) ? data.customCases : {},
    deletedCases: Array.isArray(data.deletedCases)
      ? data.deletedCases.filter((item) => typeof item === "string")
      : [],
  };
}

function encodeBase64Url(input: string | Uint8Array) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemToArrayBuffer(pem: string) {
  const normalized = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function getServiceAccountConfig(): ServiceAccountConfig {
  const raw = mustGetEnv("GOOGLE_SERVICE_ACCOUNT_JSON");
  const parsed = JSON.parse(raw);

  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key");
  }

  return {
    clientEmail: parsed.client_email,
    privateKey: parsed.private_key,
    tokenUri: parsed.token_uri ?? "https://oauth2.googleapis.com/token",
  };
}

async function createGoogleJwtAssertion(config: ServiceAccountConfig) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: config.clientEmail,
    scope: DRIVE_SCOPE,
    aud: config.tokenUri,
    iat: now,
    exp: now + 3600,
  };

  const unsignedToken = `${encodeBase64Url(JSON.stringify(header))}.${encodeBase64Url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(config.privateKey),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedToken),
  );

  return `${unsignedToken}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function getGoogleAccessToken() {
  if (cachedGoogleToken && cachedGoogleToken.expiresAt > Date.now()) {
    return cachedGoogleToken.value;
  }

  const config = getServiceAccountConfig();
  const assertion = await createGoogleJwtAssertion(config);
  const tokenRes = await fetch(config.tokenUri, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new Error(tokenJson.error_description || tokenJson.error || "Failed to get Google access token");
  }

  cachedGoogleToken = {
    value: tokenJson.access_token,
    expiresAt: Date.now() + ((tokenJson.expires_in ?? 3600) - 60) * 1000,
  };

  return cachedGoogleToken.value;
}

async function googleFetch(input: string, init: RequestInit = {}) {
  const token = await getGoogleAccessToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

async function findDriveFileId(folderId: string) {
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set(
    "q",
    `name='${DRIVE_FILENAME.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false`,
  );
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "1");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("supportsAllDrives", "true");

  const res = await googleFetch(url.toString());
  const payload = await res.json();
  if (!res.ok) {
    const message = payload.error?.message || `Drive lookup failed: ${res.status}`;
    if (message.includes(`File not found: ${folderId}`)) {
      throw new Error(
        `Google Drive folder not found for DRIVE_SHARED_FOLDER_ID="${folderId}". Check the folder id secret and folder sharing.`,
      );
    }
    throw new Error(message);
  }
  return payload.files?.[0]?.id ?? null;
}

async function createDriveFile(folderId: string) {
  const metadata = {
    name: DRIVE_FILENAME,
    parents: [folderId],
    mimeType: "application/json",
  };
  const boundary = `qa-testcases-${crypto.randomUUID()}`;
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(DEFAULT_DB),
    `--${boundary}--`,
  ].join("\r\n");

  const url = new URL(`${DRIVE_UPLOAD_API}/files`);
  url.searchParams.set("uploadType", "multipart");
  url.searchParams.set("fields", "id");
  url.searchParams.set("supportsAllDrives", "true");

  const res = await googleFetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  const payload = await res.json();
  if (!res.ok || !payload.id) {
    const message = payload.error?.message || `Drive create failed: ${res.status}`;
    if (message.includes(`File not found: ${folderId}`)) {
      throw new Error(
        `Google Drive folder not found for DRIVE_SHARED_FOLDER_ID="${folderId}". Check the folder id secret and folder sharing.`,
      );
    }
    if (message.includes("Service Accounts do not have storage quota")) {
      throw new Error(
        "Service account cannot create a new file in this Drive location. Create qa-testcases-data.json as testbulk87@gmail.com first, share that file with the service account, then set DRIVE_DATA_FILE_ID to that file id.",
      );
    }
    throw new Error(message);
  }
  return payload.id;
}

async function getOrCreateDriveFileId(folderId: string) {
  if (DRIVE_DATA_FILE_ID) return DRIVE_DATA_FILE_ID;
  const existingId = await findDriveFileId(folderId);
  if (existingId) return existingId;
  return createDriveFile(folderId);
}

async function readDriveDb(folderId: string) {
  const fileId = await getOrCreateDriveFileId(folderId);
  const url = new URL(`${DRIVE_API}/files/${fileId}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");

  const res = await googleFetch(url.toString());
  const payload = await res.json();
  if (!res.ok) throw new Error(payload.error?.message || `Drive read failed: ${res.status}`);
  return sanitizeDb(payload);
}

async function writeDriveDb(folderId: string, body: unknown) {
  const fileId = await getOrCreateDriveFileId(folderId);
  const db = sanitizeDb(body);
  const url = new URL(`${DRIVE_UPLOAD_API}/files/${fileId}`);
  url.searchParams.set("uploadType", "media");
  url.searchParams.set("supportsAllDrives", "true");

  const res = await googleFetch(url.toString(), {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(db),
  });

  if (!res.ok) {
    const payload = await res.json();
    throw new Error(payload.error?.message || `Drive write failed: ${res.status}`);
  }

  return db;
}

async function requireSupabaseUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;

  // Gateway JWT verification is intentionally disabled for this function
  // because Supabase's legacy verify_jwt flow is incompatible with newer
  // JWT signing keys. We validate the bearer token explicitly here instead.
  const supabase = createClient(
    mustGetEnv("SUPABASE_URL"),
    mustGetEnv("SUPABASE_ANON_KEY"),
    {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    },
  );

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const user = await requireSupabaseUser(req);
    if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

    const folderId = getDriveSharedFolderId();

    if (req.method === "GET") {
      return jsonResponse(await readDriveDb(folderId));
    }

    if (req.method === "PUT") {
      return jsonResponse(await writeDriveDb(folderId, await req.json()));
    }

    return jsonResponse({ error: "Method not allowed" }, 405);
  } catch (error) {
    console.error("drive-proxy error", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Unexpected error" },
      500,
    );
  }
});
