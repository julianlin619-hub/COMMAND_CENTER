/**
 * Upload Page — form for uploading media files to create new posts.
 *
 * Client component because it uses useState, event handlers, and fetch.
 */
"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UploadIcon, InfoIcon } from "lucide-react";

const PLATFORMS = [
  { value: "youtube", label: "YouTube" },
  { value: "instagram", label: "Instagram" },
  { value: "tiktok", label: "TikTok" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "x", label: "X" },
  { value: "threads", label: "Threads" },
];

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [platform, setPlatform] = useState("youtube");
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [scheduleLater, setScheduleLater] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [result, setResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;

    setUploading(true);
    setUploadProgress(0);
    setResult(null);

    /* Simulate upload progress for the Progress bar demo */
    const progressInterval = setInterval(() => {
      setUploadProgress((prev) => Math.min(prev + 15, 90));
    }, 200);

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
        setResult({
          type: "success",
          message: `Uploaded successfully. Post ID: ${data.postId}`,
        });
        setFile(null);
        setTitle("");
        setCaption("");
      } else {
        setResult({ type: "error", message: data.error });
      }
    } catch (err) {
      setResult({ type: "error", message: `Upload failed: ${err}` });
    } finally {
      clearInterval(progressInterval);
      setUploadProgress(100);
      setUploading(false);
    }
  }

  return (
    <AppShell>
      <div className="mb-6">
        <h2 className="text-lg font-medium">Upload</h2>
        <p className="text-sm text-muted-foreground">
          Upload media and create a new post
        </p>
      </div>

      <Alert className="max-w-lg mb-4">
        <InfoIcon className="size-4" />
        <AlertTitle>Upload tips</AlertTitle>
        <AlertDescription>
          Videos up to 500MB, images up to 20MB. Supported formats: MP4, MOV, JPG, PNG, WebP.
        </AlertDescription>
      </Alert>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>New Post</CardTitle>
          <CardDescription>Fill in the details and upload your media file</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleUpload} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="platform">Platform</Label>
              <Select value={platform} onValueChange={(v) => v && setPlatform(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Optional"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="caption">Caption</Label>
              <Textarea
                id="caption"
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Optional"
                rows={3}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="file">Media File</Label>
              <Input
                id="file"
                type="file"
                accept="image/*,video/*"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="cursor-pointer"
              />
            </div>

            <Separator />

            {/* Schedule toggle — demonstrates Switch component */}
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="schedule-toggle">Schedule for later</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Post will be queued instead of published immediately
                </p>
              </div>
              <Switch
                id="schedule-toggle"
                checked={scheduleLater}
                onCheckedChange={setScheduleLater}
              />
            </div>

            {scheduleLater && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="space-y-2"
              >
                <Label htmlFor="schedule-date">Schedule Date & Time</Label>
                <Input
                  id="schedule-date"
                  type="datetime-local"
                  className="w-full"
                />
              </motion.div>
            )}

            <Separator />

            {/* Upload progress bar — visible during upload */}
            {uploading && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.2 }}
              >
                <Progress value={uploadProgress}>
                  <span className="text-xs text-muted-foreground">Uploading...</span>
                </Progress>
              </motion.div>
            )}

            <motion.div whileTap={{ scale: 0.98 }}>
              <Button type="submit" disabled={!file || uploading}>
                <UploadIcon className="size-4 mr-1.5" />
                {uploading ? "Uploading..." : "Upload"}
              </Button>
            </motion.div>

            <AnimatePresence mode="wait">
              {result && (
                <motion.p
                  key={result.type}
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.2 }}
                  className={`text-sm ${
                    result.type === "success"
                      ? "text-green-500"
                      : "text-red-500"
                  }`}
                >
                  {result.message}
                </motion.p>
              )}
            </AnimatePresence>
          </form>
        </CardContent>
      </Card>
    </AppShell>
  );
}
