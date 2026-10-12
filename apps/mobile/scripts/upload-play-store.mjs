#!/usr/bin/env node

import { androidpublisher, auth as googleAuth } from "@googleapis/androidpublisher";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Usage: upload-play-store.mjs <aab> [track[,track...]]
//
// Environment (empty counts as unset):
//   AAB_PATH                   the .aab, when not given as the first argument
//   PLAY_STORE_TRACK           internal (default), alpha, beta, production, ... A comma list puts
//                              the one upload on each track, in the same edit.
//   ANDROID_PACKAGE_NAME       defaults to ATLAS_APP_ID (as app.config.ts), then app.json's package
//   PLAY_STORE_RELEASE_STATUS  completed (default), inProgress, halted or draft. `completed` rolls
//                              out to everyone on the track at once; for a staged rollout use
//                              inProgress with PLAY_STORE_USER_FRACTION.
//   PLAY_STORE_USER_FRACTION   share of users (0-1, exclusive) for inProgress / halted
//   PLAY_STORE_RELEASE_NAME    defaults to "<app.json version> (<versionCode>)"
//   RELEASE_NOTES              en-US release notes text
const STATUSES = ["completed", "inProgress", "halted", "draft"];

async function main() {
  const appJson = JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app.json"),
      "utf8",
    ),
  ).expo;
  const aabPath = process.argv[2] || process.env.AAB_PATH;
  const tracks = [
    ...new Set(
      (process.argv[3] || process.env.PLAY_STORE_TRACK || "internal")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ];
  const packageName =
    process.env.ANDROID_PACKAGE_NAME || process.env.ATLAS_APP_ID || appJson.android.package;
  const releaseNotes = process.env.RELEASE_NOTES || "Automated CI release";
  const status = process.env.PLAY_STORE_RELEASE_STATUS || "completed";
  const fractionRaw = process.env.PLAY_STORE_USER_FRACTION;
  const userFraction = fractionRaw ? Number(fractionRaw) : undefined;

  if (!STATUSES.includes(status)) {
    console.error(
      `❌ Error: PLAY_STORE_RELEASE_STATUS must be one of ${STATUSES.join(", ")} (got "${status}").`,
    );
    process.exit(1);
  }
  // Play requires a fraction for a staged (inProgress/halted) release and rejects it otherwise.
  const staged = status === "inProgress" || status === "halted";
  if (
    staged !== (userFraction !== undefined) ||
    (staged && !(userFraction > 0 && userFraction < 1))
  ) {
    console.error(
      `❌ Error: PLAY_STORE_USER_FRACTION (between 0 and 1) is required with status inProgress/halted, and only then.`,
    );
    process.exit(1);
  }

  if (!aabPath || !fs.existsSync(aabPath)) {
    console.error(`❌ Error: AAB file not found at: ${aabPath}`);
    process.exit(1);
  }

  const saJsonEnv = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  const saKeyFileEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  let auth;
  if (saJsonEnv) {
    let credentials;
    if (fs.existsSync(saJsonEnv)) {
      credentials = JSON.parse(fs.readFileSync(saJsonEnv, "utf8"));
    } else {
      credentials = JSON.parse(saJsonEnv);
    }
    auth = new googleAuth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/androidpublisher"],
    });
  } else if (saKeyFileEnv && fs.existsSync(saKeyFileEnv)) {
    auth = new googleAuth.GoogleAuth({
      keyFile: saKeyFileEnv,
      scopes: ["https://www.googleapis.com/auth/androidpublisher"],
    });
  } else {
    console.error(
      "❌ Error: No Google Play Service Account JSON found in GOOGLE_PLAY_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS.",
    );
    process.exit(1);
  }

  const client = androidpublisher({ version: "v3", auth });

  console.log(`🚀 Starting Google Play upload...`);
  console.log(`📦 Package: ${packageName}`);
  console.log(
    `🎯 Tracks: ${tracks.join(", ")} (status: ${status}${staged ? `, ${userFraction * 100}% of users` : ""})`,
  );
  console.log(`📁 AAB: ${aabPath} (${(fs.statSync(aabPath).size / 1024 / 1024).toFixed(2)} MB)`);

  try {
    // 1. Create a new edit
    console.log(`>> Creating new edit for ${packageName}...`);
    const editRes = await client.edits.insert({ packageName });
    const editId = editRes.data.id;
    if (!editId) {
      throw new Error("Failed to create edit ID");
    }
    console.log(`>> Edit created (ID: ${editId})`);

    // 2. Upload the bundle, unless Play already has this versionCode (a re-run adding a track):
    // Play refuses a second upload of a versionCode. app.json's is the one the AAB was built with.
    const existing = (await client.edits.bundles.list({ packageName, editId })).data.bundles ?? [];
    let versionCode = existing.find(
      (b) => b.versionCode === appJson.android.versionCode,
    )?.versionCode;
    if (versionCode) {
      console.log(`>> Play already has versionCode ${versionCode}; reusing it.`);
    } else {
      console.log(`>> Uploading .aab bundle...`);
      const bundleRes = await client.edits.bundles.upload({
        packageName,
        editId,
        media: {
          mimeType: "application/octet-stream",
          body: fs.createReadStream(aabPath),
        },
      });
      versionCode = bundleRes.data.versionCode;
      console.log(`>> Bundle uploaded successfully! VersionCode: ${versionCode}`);
    }
    // The Console lists releases by this name; the bare versionCode ("v49") read like a semver tag.
    const releaseName =
      process.env.PLAY_STORE_RELEASE_NAME || `${appJson.version} (${versionCode})`;

    // 3. Assign to each track
    for (const track of tracks) {
      console.log(`>> Updating track '${track}' with versionCode ${versionCode}...`);
      await client.edits.tracks.update({
        packageName,
        editId,
        track,
        requestBody: {
          track,
          releases: [
            {
              name: releaseName,
              versionCodes: [versionCode.toString()],
              status,
              ...(staged ? { userFraction } : {}),
              releaseNotes: [
                {
                  language: "en-US",
                  text: releaseNotes,
                },
              ],
            },
          ],
        },
      });
      console.log(`>> Track '${track}' updated.`);
    }

    // 4. Commit edit
    console.log(`>> Committing edit...`);
    const commitRes = await client.edits.commit({
      packageName,
      editId,
    });

    console.log(
      `✅ Success! Release "${releaseName}" committed to Google Play (${tracks.join(", ")}, ${status}). Edit ID: ${commitRes.data.id}`,
    );
  } catch (error) {
    console.error(`❌ Google Play upload failed:`, error.response?.data || error.message || error);
    process.exit(1);
  }
}

main();
