import { fetch as expoFetch } from "expo/fetch";
import type { FetchLike } from "@atlastodo/client-core";

/**
 * The fetch for attachment blob bodies on Android and iOS: Expo's native one. React Native's
 * global fetch converts a binary request body to base64 before handing it to the native side (a
 * second, larger copy of the ciphertext) and reads a response only whole; Expo's passes the bytes
 * through as they are and streams the response, so a download is decrypted as it arrives. The web
 * build resolves `blobFetch.web.ts`.
 */
export const blobFetch: FetchLike | undefined = expoFetch as unknown as FetchLike;
