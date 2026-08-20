# API-v2 Cloudflare Worker

Direct Stream Player & HLS Bypass API proxy for Cloudflare Workers.

---

## 🚀 Cloudflare Native Git Integration (Recommended)

GitHub-এ কোনো অতিরিক্ত `.github/workflows/` পারমিশন ঝামেলা ছাড়াই Cloudflare ড্যাশবোর্ড থেকে অটো-ডিপ্লয় চালু করার সবচেয়ে সহজ ও নিরাপদ উপায়:

1. [Cloudflare Dashboard](https://dash.cloudflare.com/) ➔ **Workers & Pages**-এ যান।
2. আপনার Worker (`api-v2`) ওপেন করুন অথবা **Create application** ➔ **Connect to Git** সিলেক্ট করুন।
3. আপনার GitHub রিপোজিটরি (`mdmahbub8739/API-v2`) সিলেক্ট করুন।
4. **Deploy Command**: `npm run deploy` বা ডিফল্ট সিলেক্ট করে সেভ করুন।
5. এখন থেকে GitHub-এ যেকোনো `git push` বা `git pull` করলেই ক্লাউডফ্লেয়ার অটোম্যাটিক্যালি নতুন ভার্সন বিল্ড ও ডিপ্লয় করে নিবে।

---

## 🛠️ D1 Database Schema
Cloudflare D1 কনসোলে নিচের SQL কোডটি রান করুন:

```sql
CREATE TABLE IF NOT EXISTS external_direct_links (
    link_hash TEXT PRIMARY KEY,
    original_url TEXT,
    domain TEXT,
    filecode TEXT,
    title TEXT,
    thumbnail TEXT,
    subtitles_json TEXT,
    streaming_url TEXT,
    custom_hls_url TEXT,
    target_duration INTEGER,
    segments_json TEXT,
    created_at INTEGER,
    updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_external_filecode ON external_direct_links(filecode);
```
