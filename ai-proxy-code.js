const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action } = body;
    const apiKey = "sk-chWomCfpYMqtz9F1DgqKkgsXg91ypJ2cmKtQD7m9yseJRZh0";
    const baseUrl = "https://apihub.agnes-ai.com";

    if (action === "chat") {
      const { prompt, messages, model = "agnes-2.0-flash", max_tokens = 4096 } = body;
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: messages || [{ role: "user", content: prompt }],
          max_tokens: Math.min(max_tokens, 8192),
          stream: false,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return new Response(
          JSON.stringify({
            error: "Agnes AI API 调用失败",
            detail: err.error?.message || response.statusText,
          }),
          { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const data = await response.json();
      // 清理 AI 回复中的 Markdown ** 标记
      if (data?.choices?.[0]?.message?.content) {
        data.choices[0].message.content = data.choices[0].message.content
          .replace(/\*\*/g, "");
      }
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "image") {
      const { prompt, size = "1024x768", model = "agnes-image-2.1-flash" } = body;
      const response = await fetch(`${baseUrl}/v1/images/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          prompt,
          size,
          extra_body: {
            response_format: "url",
          },
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return new Response(
          JSON.stringify({
            error: "Agnes AI 图片生成失败",
            detail: err.error?.message || response.statusText,
          }),
          { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const data = await response.json();
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "video") {
      const { prompt, image, last_frame, seed, num_frames = 121, frame_rate = 24, height, width } = body;
      // 验证 prompt 不能为空
      if (!prompt || !prompt.trim()) {
        return new Response(
          JSON.stringify({ error: "请输入视频描�?, detail: "prompt 不能为空" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // 安全地将 ArrayBuffer 转为 base64
      function arrayBufferToBase64(buffer: ArrayBuffer): string {
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
      }

      // 辅助函数：将图片URL转换为base64
      async function urlToBase64(url: string): Promise<string | null> {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10000);
          const res = await fetch(url, { signal: controller.signal });
          clearTimeout(timeoutId);
          if (!res.ok) return null;
          const contentType = res.headers.get("content-type") || "image/jpeg";
          const buffer = await res.arrayBuffer();
          const base64 = arrayBufferToBase64(buffer);
          return `data:${contentType};base64,${base64}`;
        } catch (e) {
          console.error("[ai-proxy] image URL to base64 failed:", e);
          return null;
        }
      }

      // 计算标准帧数
      let safeNumFrames = Math.min(Math.max(Math.floor(num_frames), 1), 401);
      safeNumFrames = Math.floor((safeNumFrames - 1) / 8) * 8 + 1;
      if (safeNumFrames < 9) safeNumFrames = 9;
      const safeFrameRate = Math.min(Math.max(Math.floor(frame_rate), 1), 60);

      // 将图片URL转换为base64（Agnes API 可能无法直接访问外部URL�?      const imageBase64 = image && typeof image === "string" && image.trim().length > 0
        ? await urlToBase64(image.trim())
        : null;
      const lastFrameBase64 = last_frame && typeof last_frame === "string" && last_frame.trim().length > 0
        ? await urlToBase64(last_frame.trim())
        : null;

      console.log("[ai-proxy] video params:", { prompt: prompt.slice(0, 50), numFrames: safeNumFrames, frameRate: safeFrameRate, hasImage: !!imageBase64, hasLastFrame: !!lastFrameBase64 });

      // 构建请求体： Agnes /v1/videos 端点接受 height/width/num_frames/frame_rate
      const requestBody: Record<string, unknown> = {
        model: "agnes-video-v2.0",
        prompt,
        height: typeof height === "number" && height > 0 ? height : 720,
        width: typeof width === "number" && width > 0 ? width : 1280,
        num_frames: safeNumFrames,
        frame_rate: safeFrameRate,
      };
      if (imageBase64) requestBody.image = imageBase64;
      if (lastFrameBase64 && lastFrameBase64 !== imageBase64) requestBody.last_frame = lastFrameBase64;
      if (typeof seed === "number" && seed >= 0) requestBody.seed = seed;

      console.log("[ai-proxy] video create ->", `${baseUrl}/v1/videos`);
      const createRes = await fetch(`${baseUrl}/v1/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(requestBody),
      });

      if (!createRes.ok) {
        const errText = await createRes.text().catch(() => "");
        let err: Record<string, unknown> = {};
        try { err = JSON.parse(errText); } catch { /* keep as text */ }
        console.error("[ai-proxy] video create failed:", createRes.status, errText);
        const detail =
          (err.error as Record<string, string>)?.message ||
          err.message ||
          err.detail ||
          err.error ||
          createRes.statusText;
        return new Response(
          JSON.stringify({
            error: "Agnes AI 视频生成任务创建失败",
            detail: typeof detail === "string" ? detail : createRes.statusText,
          }),
          { status: createRes.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const taskData = await createRes.json();
      console.log("[ai-proxy] video create success:", taskData.video_id || taskData.id);
      return new Response(JSON.stringify(taskData), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "video_status") {
      const { video_id } = body;
      // 尝试标准 /v1/videos 路径，fallback 到旧路径
      const endpoints = [
        `${baseUrl}/v1/videos/${video_id}`,
        `${baseUrl}/agnesapi?video_id=${video_id}`,
      ];

      let lastErr = "";
      for (const url of endpoints) {
        try {
          const response = await fetch(url, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
          });

          if (response.ok) {
            const data = await response.json();
            // Agnes AI 将视频URL放在 remixed_from_video_id 字段�?            if (data.remixed_from_video_id && typeof data.remixed_from_video_id === "string" && data.remixed_from_video_id.startsWith("http")) {
              data.video_url = data.remixed_from_video_id;
            }
            return new Response(JSON.stringify(data), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          lastErr = await response.text().catch(() => response.statusText);
        } catch (e) {
          lastErr = e.message || String(e);
        }
      }

      return new Response(
        JSON.stringify({
          error: "查询视频状态失�?,
          detail: lastErr,
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ error: "无效的操�? }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
