"use client";

import { useState } from "react";
import { UserButton } from "@clerk/nextjs";
import Link from "next/link";

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [platform, setPlatform] = useState("youtube");
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;

    setUploading(true);
    setResult(null);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("platform", platform);
    if (title) formData.append("title", title);
    if (caption) formData.append("caption", caption);

    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (res.ok) {
        setResult(`Uploaded. Post ID: ${data.postId}`);
        setFile(null);
        setTitle("");
        setCaption("");
      } else {
        setResult(`Error: ${data.error}`);
      }
    } catch (err) {
      setResult(`Upload failed: ${err}`);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="min-h-screen">
      <header className="border-b bg-white px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">
          <Link href="/">Command Center</Link> / Upload
        </h1>
        <UserButton />
      </header>

      <main className="p-6 max-w-lg">
        <form onSubmit={handleUpload} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Platform</label>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm"
            >
              <option value="youtube">YouTube</option>
              <option value="instagram">Instagram</option>
              <option value="tiktok">TikTok</option>
              <option value="linkedin">LinkedIn</option>
              <option value="x">X</option>
              <option value="threads">Threads</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm"
              placeholder="Optional"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Caption</label>
            <textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm"
              rows={3}
              placeholder="Optional"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Media File
            </label>
            <input
              type="file"
              accept="image/*,video/*"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="text-sm"
            />
          </div>

          <button
            type="submit"
            disabled={!file || uploading}
            className="bg-black text-white px-4 py-2 rounded text-sm disabled:opacity-50"
          >
            {uploading ? "Uploading..." : "Upload"}
          </button>

          {result && (
            <p className="text-sm mt-2 text-gray-700">{result}</p>
          )}
        </form>
      </main>
    </div>
  );
}
