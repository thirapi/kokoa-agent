export const githubTools = [
  {
    functionDeclarations: [
      {
        name: "listGitHubIssues",
        description: "Mengambil daftar issue dari repositori GitHub tertentu.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: {
              type: "STRING",
              description: "Username atau organisasi pemilik repo.",
            },
            repo: { type: "STRING", description: "Nama repositori." },
            state: {
              type: "STRING",
              description: "Status issue: 'open', 'closed', atau 'all'.",
              enum: ["open", "closed", "all"],
            },
          },
          required: ["owner", "repo"],
        },
      },
      {
        name: "getPRDiff",
        description:
          "Mengambil diff (perubahan kode) mentah dari Pull Request di GitHub.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: {
              type: "STRING",
              description: "Username atau organisasi pemilik repo.",
            },
            repo: { type: "STRING", description: "Nama repositori." },
            pull_number: { type: "NUMBER", description: "Nomor Pull Request." },
          },
          required: ["owner", "repo", "pull_number"],
        },
      },
      {
        name: "createGitHubIssue",
        description: "Membuat issue baru di repositori GitHub tertentu.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: {
              type: "STRING",
              description: "Username atau organisasi pemilik repo.",
            },
            repo: { type: "STRING", description: "Nama repositori." },
            title: { type: "STRING", description: "Judul issue." },
            body: { type: "STRING", description: "Isi atau deskripsi issue." },
            labels: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "Daftar label untuk issue.",
            },
          },
          required: ["owner", "repo", "title"],
        },
      },
      {
        name: "getFileContent",
        description: "Membaca isi file mentah dari repositori GitHub.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: {
              type: "STRING",
              description: "Username atau organisasi pemilik repo.",
            },
            repo: { type: "STRING", description: "Nama repositori." },
            path: {
              type: "STRING",
              description: "Path lengkap ke file dalam repo (contoh: src/index.js).",
            },
            ref: {
              type: "STRING",
              description: "Nama branch, commit SHA, atau tag. Default ke default branch.",
            },
          },
          required: ["owner", "repo", "path"],
        },
      },
      {
        name: "createOrUpdateFile",
        description: "Membuat baru atau memperbarui file yang sudah ada di repositori GitHub.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: {
              type: "STRING",
              description: "Username atau organisasi pemilik repo.",
            },
            repo: { type: "STRING", description: "Nama repositori." },
            path: {
              type: "STRING",
              description: "Path lengkap ke file tujuan dalam repo.",
            },
            message: {
              type: "STRING",
              description: "Pesan commit.",
            },
            content: {
              type: "STRING",
              description: "Isi file teks biasa.",
            },
            sha: {
              type: "STRING",
              description: "SHA dari file yang akan diupdate (diperlukan jika memperbarui file yang sudah ada).",
            },
            branch: {
              type: "STRING",
              description: "Nama branch tujuan commit. Default ke default branch.",
            },
          },
          required: ["owner", "repo", "path", "message", "content"],
        },
      },
      {
        name: "createPullRequest",
        description: "Membuat Pull Request baru di repositori GitHub.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: {
              type: "STRING",
              description: "Username atau organisasi pemilik repo.",
            },
            repo: { type: "STRING", description: "Nama repositori." },
            title: {
              type: "STRING",
              description: "Judul Pull Request.",
            },
            head: {
              type: "STRING",
              description: "Nama branch asal perubahan (contoh: feature-branch).",
            },
            base: {
              type: "STRING",
              description: "Nama branch tujuan merge (contoh: main atau master).",
            },
            body: {
              type: "STRING",
              description: "Deskripsi isi Pull Request.",
            },
          },
          required: ["owner", "repo", "title", "head", "base"],
        },
      },
      {
        name: "mergePullRequest",
        description: "Menggabungkan (merge) Pull Request di GitHub.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: {
              type: "STRING",
              description: "Username atau organisasi pemilik repo.",
            },
            repo: { type: "STRING", description: "Nama repositori." },
            pull_number: {
              type: "NUMBER",
              description: "Nomor Pull Request.",
            },
            commit_title: {
              type: "STRING",
              description: "Judul commit merge opsional.",
            },
            merge_method: {
              type: "STRING",
              description: "Metode merge: 'merge', 'squash', atau 'rebase'. Default ke 'merge'.",
              enum: ["merge", "squash", "rebase"],
            },
          },
          required: ["owner", "repo", "pull_number"],
        },
      },
      {
        name: "addLabels",
        description: "Menambahkan label ke issue atau Pull Request.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: {
              type: "STRING",
              description: "Username atau organisasi pemilik repo.",
            },
            repo: { type: "STRING", description: "Nama repositori." },
            issue_number: {
              type: "NUMBER",
              description: "Nomor issue atau Pull Request.",
            },
            labels: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "List nama label yang ingin ditambahkan.",
            },
          },
          required: ["owner", "repo", "issue_number", "labels"],
        },
      },
      {
        name: "assignUser",
        description: "Menetapkan assignee pada issue atau Pull Request.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: {
              type: "STRING",
              description: "Username atau organisasi pemilik repo.",
            },
            repo: { type: "STRING", description: "Nama repositori." },
            issue_number: {
              type: "NUMBER",
              description: "Nomor issue atau Pull Request.",
            },
            assignees: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "List username GitHub yang akan dijadikan assignee.",
            },
          },
          required: ["owner", "repo", "issue_number", "assignees"],
        },
      },
      {
        name: "createBranch",
        description: "Membuat branch baru di repositori GitHub dari branch/commit tertentu. Gunakan sebelum membuat perubahan dan Pull Request.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: { type: "STRING", description: "Username atau organisasi pemilik repo." },
            repo: { type: "STRING", description: "Nama repositori." },
            branch: { type: "STRING", description: "Nama branch baru yang akan dibuat." },
            from_branch: { type: "STRING", description: "Branch sumber (default: default branch repo)." },
          },
          required: ["owner", "repo", "branch"],
        },
      },
      {
        name: "createIssueComment",
        description: "Membuat komentar baru pada issue atau Pull Request di GitHub.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: {
              type: "STRING",
              description: "Username atau organisasi pemilik repo.",
            },
            repo: { type: "STRING", description: "Nama repositori." },
            issue_number: {
              type: "NUMBER",
              description: "Nomor issue atau Pull Request.",
            },
            body: {
              type: "STRING",
              description: "Isi teks komentar.",
            },
          },
          required: ["owner", "repo", "issue_number", "body"],
        },
      },
      {
        name: "updateIssueState",
        description: "Memperbarui status atau detail issue GitHub (misal: menutup issue).",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: { type: "STRING", description: "Username pemilik repo." },
            repo: { type: "STRING", description: "Nama repositori." },
            issue_number: { type: "NUMBER", description: "Nomor issue." },
            state: {
              type: "STRING",
              description: "Status baru: 'open' atau 'closed'.",
              enum: ["open", "closed"],
            },
            title: { type: "STRING", description: "Judul baru jika ingin diubah." },
            body: { type: "STRING", description: "Deskripsi baru jika ingin diubah." },
          },
          required: ["owner", "repo", "issue_number"],
        },
      },
      {
        name: "updatePRState",
        description: "Memperbarui status atau detail Pull Request GitHub (misal: menutup PR tanpa merge).",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: { type: "STRING", description: "Username pemilik repo." },
            repo: { type: "STRING", description: "Nama repositori." },
            pull_number: { type: "NUMBER", description: "Nomor Pull Request." },
            state: {
              type: "STRING",
              description: "Status baru: 'open' atau 'closed'.",
              enum: ["open", "closed"],
            },
            title: { type: "STRING", description: "Judul baru jika ingin diubah." },
            body: { type: "STRING", description: "Deskripsi baru jika ingin diubah." },
            base: { type: "STRING", description: "Branch tujuan baru (contoh: 'main')." },
          },
          required: ["owner", "repo", "pull_number"],
        },
      },
      {
        name: "listDirectoryContents",
        description: "Melihat isi dari sebuah direktori di repositori GitHub.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: { type: "STRING", description: "Username pemilik repo." },
            repo: { type: "STRING", description: "Nama repositori." },
            path: { type: "STRING", description: "Path ke direktori (contoh: 'src/utils')." },
            ref: { type: "STRING", description: "Nama branch atau tag." },
          },
          required: ["owner", "repo", "path"],
        },
      },
      {
        name: "deleteFile",
        description: "Menghapus file dari repositori GitHub.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: { type: "STRING", description: "Username pemilik repo." },
            repo: { type: "STRING", description: "Nama repositori." },
            path: { type: "STRING", description: "Path ke file yang akan dihapus." },
            message: { type: "STRING", description: "Pesan commit penghapusan." },
            sha: { type: "STRING", description: "SHA file yang akan dihapus (didapat dari getFileContent atau listDirectoryContents)." },
            branch: { type: "STRING", description: "Nama branch." },
          },
          required: ["owner", "repo", "path", "message", "sha"],
        },
      },
      {
        name: "searchInFiles",
        description: "Mencari kode di seluruh repositori GitHub menggunakan query (seperti grep).",
        parameters: {
          type: "OBJECT",
          properties: {
            q: { type: "STRING", description: "Query pencarian (contoh: 'function login repo:owner/repo')." },
            sort: { type: "STRING", description: "Urutan: 'indexed' (default)." },
            order: { type: "STRING", description: "Order: 'desc' atau 'asc'." },
          },
          required: ["q"],
        },
      },
      {
        name: "triggerDeveloperWorkflow",
        description: "DELEGASI ke GitHub Actions. HANYA untuk: (1) mode 'code' — bikin fitur, commit, buat PR; (2) tugas yang butuh kompilasi/install npm/test berat. JANGAN pake untuk analisis sederhana (hitung file, grep, baca struktur) — itu bisa pake cloneRepo + listLocalDir + grepLocalFiles langsung.",
        parameters: {
          type: "OBJECT",
          properties: {
            target_repo: {
              type: "STRING",
              description: "Nama repositori target penuh (contoh: 'thirapi/62chan' atau 'thirapi/tg-bot').",
            },
            instruction: {
              type: "STRING",
              description: "Instruksi jelas untuk dikerjakan di runner.",
            },
            mode: {
              type: "STRING",
              description: "'code' (default): clone, nulis/ubah kode, commit, buat PR.",
              enum: ["code", "analysis"],
            },
          },
          required: ["target_repo", "instruction"],
        },
      },
      {
        name: "checkWorkflowStatus",
        description: "Mengecek status terakhir workflow GitHub Actions yang pernah dipicu. Gunakan untuk melihat apakah task development masih jalan, udah selesai, atau gagal.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: {
              type: "STRING",
              description: "Username atau organisasi pemilik repo.",
            },
            repo: {
              type: "STRING",
              description: "Nama repositori.",
            },
          },
          required: ["owner", "repo"],
        },
      },
      {
        name: "webSearch",
        description: "Mencari informasi terbaru dari internet. Gunakan untuk berita terkini, data real-time, atau topik yang mungkin tidak ada di pengetahuan Cocoa. Hasil berupa daftar judul, URL, dan cuplikan.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: {
              type: "STRING",
              description: "Kata kunci pencarian (gunakan bahasa Indonesia atau Inggris).",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "webFetch",
        description: "Mengambil dan membaca isi halaman web dari URL tertentu. Gunakan untuk membaca artikel, dokumentasi teknis, atau konten dari hasil webSearch.",
        parameters: {
          type: "OBJECT",
          properties: {
            url: {
              type: "STRING",
              description: "URL lengkap halaman web yang ingin dibaca.",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "imageSearch",
        description: "Mencari gambar dari internet. Hasil berupa judul, URL halaman sumber, dan URL gambar langsung. Pakai kata kunci bahasa Inggris bila hasil kosong. Panggil sendPhoto setelahnya untuk mengirim gambar pilihan ke chat.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: {
              type: "STRING",
              description: "Kata kunci pencarian gambar.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "songSearch",
        description: "Mencari lagu (judul, penyanyi, album, preview audio 30 detik, cover, link lagu full). Panggil sendAudio dengan previewUrl untuk mengirim cuplikan ke chat, dan sertakan songUrl agar user bisa dengar full di Apple Music/Spotify.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: {
              type: "STRING",
              description: "Judul lagu dan/atau nama penyanyi.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "youtubeSearch",
        description: "Mencari video YouTube (cocok untuk full lagu/musik). Hasil berupa judul, channel, dan link tonton. Bagikan watchUrl ke user agar bisa dengar/nonton full di YouTube.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: {
              type: "STRING",
              description: "Judul lagu/video dan/atau nama artis/channel.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "freeMusicSearch",
        description: "Mencari musik gratis berlisensi Creative Commons (ccMixter). Hasil ada downloadUrl MP3 full + info lisensi. Kirim via sendAudio dengan performer=artis. JANGAN dipakai untuk lagu mainstream berhak cipta (pakai songSearch+youtubeSearch untuk itu).",
        parameters: {
          type: "OBJECT",
          properties: {
            query: {
              type: "STRING",
              description: "Mood/genre/instrumen (misal: chill, rock, piano). Kata Inggris lebih akurat.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "sendLegalFile",
        description: "Mengirim file audio/gambar FULL dari URL langsung ke chat. HANYA untuk sumber legal (Creative Commons/public domain). Domain yang diizinkan: ccmixter.org, upload.wikimedia.org. URL lain DITOLAK. Pakai untuk downloadUrl dari freeMusicSearch.",
        parameters: {
          type: "OBJECT",
          properties: {
            fileUrl: {
              type: "STRING",
              description: "URL langsung ke file.",
            },
            kind: {
              type: "STRING",
              description: "'audio', 'image', atau 'auto' (tebak dari ekstensi).",
              enum: ["audio", "image", "auto"],
            },
            performer: {
              type: "STRING",
              description: "Nama artis (untuk audio, wajib diisi sebagai atribusi lisensi).",
            },
            title: {
              type: "STRING",
              description: "Judul (opsional).",
            },
          },
          required: ["fileUrl"],
        },
      },
      {
        name: "sendPhoto",
        description: "Mengirim foto/gambar dari URL langsung ke chat Telegram saat ini. Pakai imageUrl dari hasil imageSearch atau artworkUrl dari songSearch.",
        parameters: {
          type: "OBJECT",
          properties: {
            imageUrl: {
              type: "STRING",
              description: "URL langsung ke file gambar.",
            },
            caption: {
              type: "STRING",
              description: "Caption singkat untuk foto (opsional).",
            },
          },
          required: ["imageUrl"],
        },
      },
      {
        name: "sendAudio",
        description: "Mengirim audio ke chat Telegram saat ini. Pakai previewUrl dari hasil songSearch untuk mengirim cuplikan lagu 30 detik.",
        parameters: {
          type: "OBJECT",
          properties: {
            audioUrl: {
              type: "STRING",
              description: "URL langsung ke file audio (misal previewUrl iTunes).",
            },
            performer: {
              type: "STRING",
              description: "Nama penyanyi/artis (opsional).",
            },
            title: {
              type: "STRING",
              description: "Judul lagu (opsional).",
            },
          },
          required: ["audioUrl"],
        },
      },
      {
        name: "createTaskPlan",
        description: "Membuat rencana tugas (task plan) dengan beberapa langkah. Gunakan ini ketika pengguna memberikan perintah kompleks yang butuh banyak langkah. Buat daftar langkah-langkahnya, eksekusi satu per satu, dan update status setiap langkah.",
        parameters: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING", description: "Judul rencana/plan." },
            description: { type: "STRING", description: "Deskripsi tujuan plan ini." },
            steps: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "Daftar langkah-langkah yang harus dilakukan, urut dari pertama sampai terakhir.",
            },
          },
          required: ["title", "steps"],
        },
      },
      {
        name: "getTaskPlan",
        description: "Melihat daftar tugas yang sudah dibuat dan statusnya saat ini. Panggil untuk cek progress atau lihat tugas apa yang masih pending.",
        parameters: {
          type: "OBJECT",
          properties: {},
          required: [],
        },
      },
      {
        name: "updateTaskStatus",
        description: "Memperbarui status sebuah tugas. Panggil setelah selesai mengerjakan satu langkah untuk menandai progres.",
        parameters: {
          type: "OBJECT",
          properties: {
            task_id: { type: "NUMBER", description: "ID tugas yang akan diupdate." },
            status: {
              type: "STRING",
              description: "Status baru: 'pending', 'in_progress', 'completed', 'failed'.",
              enum: ["pending", "in_progress", "completed", "failed"],
            },
          },
          required: ["task_id", "status"],
        },
      },
      {
        name: "clearTaskPlan",
        description: "Menghapus semua tugas dalam plan saat ini. Panggil jika plan sudah selesai semua atau ingin memulai plan baru dari awal.",
        parameters: {
          type: "OBJECT",
          properties: {},
          required: [],
        },
      },
      {
        name: "remember",
        description: "Menyimpan informasi penting tentang pengguna atau konteks obrolan ke memori jangka panjang. Gunakan untuk mengingat nama, preferensi, project, atau fakta apapun yang perlu diingat di sesi mendatang.",
        parameters: {
          type: "OBJECT",
          properties: {
            key: { type: "STRING", description: "Nama/kategori informasi (contoh: 'nama_pengguna', 'project_utama')." },
            value: { type: "STRING", description: "Isi informasi yang ingin disimpan." },
          },
          required: ["key", "value"],
        },
      },
      {
        name: "recall",
        description: "Mengambil informasi yang sudah disimpan di memori jangka panjang berdasarkan kata kunci. Gunakan untuk mengingat detail tentang pengguna atau konteks.",
        parameters: {
          type: "OBJECT",
          properties: {
            key: { type: "STRING", description: "Kata kunci memori yang ingin diingat." },
          },
          required: ["key"],
        },
      },
      {
        name: "recallAll",
        description: "Mengambil semua informasi yang tersimpan di memori jangka panjang untuk sesi ini. Gunakan saat butuh konteks lengkap tentang pengguna.",
        parameters: {
          type: "OBJECT",
          properties: {},
          required: [],
        },
      },
      {
        name: "forget",
        description: "Menghapus informasi tertentu dari memori jangka panjang.",
        parameters: {
          type: "OBJECT",
          properties: {
            key: { type: "STRING", description: "Kata kunci memori yang ingin dihapus." },
          },
          required: ["key"],
        },
      },
      {
        name: "setReminder",
        description: "Membuat pengingat. Gunakan untuk mengingatkan pengguna tentang sesuatu di waktu yang akan datang. Pengingat akan dikirim otomatis via chat.",
        parameters: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING", description: "Pesan atau judul pengingat." },
            delay_minutes: { type: "NUMBER", description: "Berapa menit lagi dari sekarang pengingat mau dikirim? (minimal 1 menit)." },
            recurring: { type: "STRING", description: "'daily' untuk pengingat harian, atau kosongkan untuk sekali saja." },
          },
          required: ["title", "delay_minutes"],
        },
      },
      {
        name: "getReminders",
        description: "Melihat daftar pengingat yang aktif dan jadwalnya.",
        parameters: {
          type: "OBJECT",
          properties: {},
          required: [],
        },
      },
      {
        name: "deleteReminder",
        description: "Menghapus pengingat yang sudah tidak diperlukan.",
        parameters: {
          type: "OBJECT",
          properties: {
            reminder_id: { type: "NUMBER", description: "ID pengingat yang akan dihapus." },
          },
          required: ["reminder_id"],
        },
      },
    ],
  },
];

export const trelloTools = [
  {
    functionDeclarations: [
      {
        name: "getTrelloBoard",
        description: "Mengambil detail board Trello, daftar kolom (lists), dan kartu yang ada di dalamnya.",
        parameters: {
          type: "OBJECT",
          properties: {
            boardId: { type: "STRING", description: "ID Board Trello (opsional jika sudah ada di memori/env)." },
          },
          required: [],
        },
      },
      {
        name: "getTrelloLists",
        description: "Mengambil daftar kolom (lists) dalam sebuah Board Trello.",
        parameters: {
          type: "OBJECT",
          properties: {
            boardId: { type: "STRING", description: "ID Board Trello." },
          },
          required: [],
        },
      },
      {
        name: "createTrelloList",
        description: "Membuat kolom (list) baru dalam Board Trello.",
        parameters: {
          type: "OBJECT",
          properties: {
            boardId: { type: "STRING", description: "ID Board Trello." },
            name: { type: "STRING", description: "Nama kolom baru (contoh: 'QA Review', 'In Progress')." },
          },
          required: ["name"],
        },
      },
      {
        name: "createTrelloCard",
        description: "Membuat kartu Trello baru di board/kolom tertentu. Otomatis mencari/membuat kolom jika listName diberikan, dan membuat checklist sub-tugas jika subtasks diberikan.",
        parameters: {
          type: "OBJECT",
          properties: {
            boardId: { type: "STRING", description: "ID Board Trello." },
            listId: { type: "STRING", description: "ID kolom/list Trello tujuan." },
            listName: { type: "STRING", description: "Nama kolom/list Trello tujuan (contoh: 'To Do', 'In Progress', 'Backlog')." },
            name: { type: "STRING", description: "Judul kartu Trello." },
            desc: { type: "STRING", description: "Deskripsi rinci kartu, analisis kompleksitas, atau rincian masalah." },
            subtasks: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "Daftar sub-tugas yang akan dijadikan checklist di dalam kartu.",
            },
            due: { type: "STRING", description: "Tanggal/jam tenggat (format ISO 8601)." },
            labels: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "Daftar ID label." },
          },
          required: ["name"],
        },
      },
      {
        name: "addTrelloChecklist",
        description: "Menambahkan checklist atau sub-tugas ke dalam kartu Trello yang sudah ada.",
        parameters: {
          type: "OBJECT",
          properties: {
            cardId: { type: "STRING", description: "ID kartu Trello." },
            title: { type: "STRING", description: "Judul checklist (default: 'Sub-tugas')." },
            items: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "Daftar item sub-tugas.",
            },
          },
          required: ["cardId", "items"],
        },
      },
      {
        name: "addTrelloAttachment",
        description: "Melampirkan URL atau gambar referensi ke kartu Trello.",
        parameters: {
          type: "OBJECT",
          properties: {
            cardId: { type: "STRING", description: "ID kartu Trello." },
            url: { type: "STRING", description: "URL gambar atau tautan referensi." },
            name: { type: "STRING", description: "Nama lampiran." },
          },
          required: ["cardId", "url"],
        },
      },
      {
        name: "moveTrelloCard",
        description: "Memindahkan kartu Trello ke kolom/list lain.",
        parameters: {
          type: "OBJECT",
          properties: {
            cardId: { type: "STRING", description: "ID kartu Trello." },
            targetListId: { type: "STRING", description: "ID kolom tujuan." },
            targetListName: { type: "STRING", description: "Nama kolom tujuan (misal: 'In Progress', 'Done')." },
            boardId: { type: "STRING", description: "ID Board Trello." },
          },
          required: ["cardId"],
        },
      },
      {
        name: "updateTrelloCard",
        description: "Memperbarui detail kartu Trello (nama, deskripsi, due date, status).",
        parameters: {
          type: "OBJECT",
          properties: {
            cardId: { type: "STRING", description: "ID kartu Trello." },
            name: { type: "STRING", description: "Judul baru." },
            desc: { type: "STRING", description: "Deskripsi baru." },
            due: { type: "STRING", description: "Due date baru." },
            closed: { type: "BOOLEAN", description: "Set true untuk mengarsip/menutup kartu." },
          },
          required: ["cardId"],
        },
      },
      {
        name: "createTrelloBoard",
        description: "Membuat Board Trello baru.",
        parameters: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING", description: "Nama board baru (contoh: 'Project Task')." },
            desc: { type: "STRING", description: "Deskripsi board." },
          },
          required: ["name"],
        },
      },
    ],
  },
];

export const spacesTools = [
  {
    functionDeclarations: [
      {
        name: "cloneRepo",
        description: "Clone GitHub repo ke filesystem lokal server. Cepet buat baca banyak file tanpa panggil GitHub API tiap kali.",
        parameters: {
          type: "OBJECT",
          properties: {
            repo: { type: "STRING", description: "Nama repo lengkap (contoh: 'thirapi/tg-bot')." },
            ref: { type: "STRING", description: "Branch/tag/commit (default: default branch)." },
          },
          required: ["repo"],
        },
      },
      {
        name: "readLocalFile",
        description: "Baca file dari filesystem lokal (hasil cloneRepo). Path bisa dari hasil cloneRepo.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "Path lengkap ke file di filesystem." },
          },
          required: ["path"],
        },
      },
      {
        name: "listLocalDir",
        description: "Lihat isi direktori di filesystem lokal.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "Path direktori yang mau dilihat." },
          },
          required: ["path"],
        },
      },
      {
        name: "grepLocalFiles",
        description: "Cari teks/regex di file-file dalam direktori lokal. Mirip grep -r.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "Base direktori buat nyari." },
            pattern: { type: "STRING", description: "Pola regex yang dicari." },
            include: { type: "STRING", description: "Filter ekstensi file (contoh: '*.js')." },
          },
          required: ["path", "pattern"],
        },
      },
      {
        name: "runCommand",
        description: "Jalanin perintah shell (test, build, lint, dsb). Berguna untuk verifikasi atau task development cepat. WARNING: perintah bakal jalan di server -- hanya jalanin perintah yang aman.",
        parameters: {
          type: "OBJECT",
          properties: {
            command: { type: "STRING", description: "Perintah shell yang mau dijalanin (contoh: 'npm test')." },
            cwd: { type: "STRING", description: "Direktori kerja tempat jalanin perintah." },
            timeout: { type: "NUMBER", description: "Timeout dalam detik (default: 30, max: 120)." },
          },
          required: ["command", "cwd"],
        },
      },
    ],
  },
];

