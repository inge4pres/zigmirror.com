/**
 * Zig Mirror Proxy Cache Server
 * 
 * This worker acts as a proxy cache for Zig downloads, storing objects in R2.
 * It validates Zig tarball filenames according to the official parsing rules
 * and serves files from cache or fetches them from ziglang.org.
 * 
 * See https://github.com/ziglang/www.ziglang.org/blob/main/MIRRORS.md.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

// Regex pattern for validating Zig tarball filenames as per official documentation
const ZIG_FILENAME_REGEX = /^zig(?:|-bootstrap|-[a-zA-Z0-9_]+-[a-zA-Z0-9_]+)-(\d+\.\d+\.\d+(?:-dev\.\d+\+[0-9a-f]+)?)\.(?:tar\.xz|zip)(?:\.minisig)?$/;

export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request) {
    const url = new URL(request.url);
    
    // Only allow GET requests
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          Allow: "GET",
        },
      });
    }

    const filename = url.pathname.slice(1); // Remove leading slash
    
    // If filename is empty, serve the main page
    if (!filename) {
      return this.env.ASSETS.fetch(new Request(new URL("/", request.url)));
    }

    // If filename doesn't start with 'zig-', serve static assets
    if (!filename.startsWith("zig-")) {
      return this.env.ASSETS.fetch(request);
    }

    // Handle Zig downloads
    return this.handleZigDownload(filename);
  }

  private async handleZigDownload(filename: string): Promise<Response> {
    // Validate filename against Zig tarball naming schema
    const match = filename.match(ZIG_FILENAME_REGEX);
    if (!match) {
      return new Response("Invalid filename format", { status: 404 });
    }

    const version = match[1]; // Captured version string
    const isPreRelease = version.includes("-dev.");

    try {
      // Check if file exists in R2 bucket
      const existingObject = await this.env.BUCKET.head(filename);
      
      if (existingObject) {
        // File exists in R2, return the public URL
        const bucketPublicUrl = this.getBucketPublicUrl();
        return Response.redirect(`${bucketPublicUrl}/${filename}`, 302);
      }

      // File doesn't exist in R2, download from ziglang.org
      const sourceUrl = this.getSourceUrl(filename, version, isPreRelease);
      const response = await fetch(sourceUrl);

      if (!response.ok) {
        return new Response(`File not found at source: ${response.status}`, { status: 404 });
      }

      // Store the file in R2 bucket
      const body = await response.blob();
      await this.env.BUCKET.put(filename, body, {
        httpMetadata: {
          contentType: response.headers.get("content-type") || this.getContentType(filename),
          cacheControl: "public, max-age=172800", // Cache for 48 hours
        },
      });

      // Return the public URL for the newly cached file
      const bucketPublicUrl = this.getBucketPublicUrl();
      return Response.redirect(`${bucketPublicUrl}/${filename}`, 302);

    } catch (error) {
      console.error("Error processing request:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  /**
   * Get the source URL for downloading from ziglang.org
   */
  private getSourceUrl(filename: string, version: string, isPreRelease: boolean): string {
    if (isPreRelease) {
      // Pre-release builds are in /builds/
      return `https://ziglang.org/builds/${filename}`;
    } else {
      // Normal releases are in /download/<version>/
      return `https://ziglang.org/download/${version}/${filename}`;
    }
  }

  /**
   * Get the public URL for the R2 bucket
   */
  private getBucketPublicUrl(): string {
    return this.env.BUCKET_PUBLIC_URL;
  }

  /**
   * Determine content type based on file extension
   */
  private getContentType(filename: string): string {
    if (filename.endsWith(".tar.xz")) {
      return "application/x-xz";
    } else if (filename.endsWith(".zip")) {
      return "application/zip";
    } else if (filename.endsWith(".minisig")) {
      return "text/plain";
    }
    return "application/octet-stream";
  }
};