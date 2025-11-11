require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());


const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon thường cần SSL
});

// Helper
function arraysEqual(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// ========== API ==========

// Tạo project mới
app.post("/api/projects", async (req, res) => {
  try {
    const { name, segment_count, clips_per_segment } = req.body;
    if (!name || !segment_count || !clips_per_segment) {
      return res.status(400).json({ error: "Thiếu name / segment_count / clips_per_segment" });
    }

    const result = await pool.query(
      `INSERT INTO projects (name, segment_count, clips_per_segment)
       VALUES ($1, $2, $3)
       RETURNING id, name, segment_count, clips_per_segment, created_at`,
      [name, segment_count, clips_per_segment]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server khi tạo project" });
  }
});

app.get("/api/projects", async (req, res) => {
  const page = parseInt(req.query.page || "1", 10);
  const limit = parseInt(req.query.limit || "10", 10);
  const search = (req.query.search || "").trim();

  const offset = (page - 1) * limit;

  try {
    let countRes, listRes;

    if (search) {
      countRes = await pool.query(
        `SELECT COUNT(*) FROM projects
         WHERE name ILIKE '%' || $1 || '%' OR CAST(id AS TEXT) = $1`,
        [search]
      );
      listRes = await pool.query(
        `SELECT * FROM projects
         WHERE name ILIKE '%' || $1 || '%' OR CAST(id AS TEXT) = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [search, limit, offset]
      );
    } else {
      countRes = await pool.query("SELECT COUNT(*) FROM projects");
      listRes = await pool.query(
        `SELECT * FROM projects
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
    }

    const total = parseInt(countRes.rows[0].count, 10);
    const totalPages = Math.max(1, Math.ceil(total / limit));

    res.json({
      projects: listRes.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server khi lấy danh sách project" });
  }
});


// Lấy thông tin project + danh sách biến thể
app.get("/api/projects/:id", async (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  if (!projectId) return res.status(400).json({ error: "projectId không hợp lệ" });

  try {
    const projectRes = await pool.query(
      "SELECT * FROM projects WHERE id = $1",
      [projectId]
    );
    if (projectRes.rows.length === 0) {
      return res.status(404).json({ error: "Không tìm thấy project" });
    }

    const variantsRes = await pool.query(
      `SELECT v.id,
              v.name,
              v.created_at,
              json_agg(json_build_object('segment_index', vs.segment_index + 1, 'clip_index', vs.clip_index)
                       ORDER BY vs.segment_index) AS segments
       FROM variants v
       JOIN variant_segments vs ON vs.variant_id = v.id
       WHERE v.project_id = $1
       GROUP BY v.id
       ORDER BY v.id DESC`,
      [projectId]
    );

    res.json({
      project: projectRes.rows[0],
      variants: variantsRes.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server khi lấy project" });
  }
});

// Tạo biến thể mới
app.post("/api/projects/:id/variants", async (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  if (!projectId) return res.status(400).json({ error: "projectId không hợp lệ" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lấy project
    const projRes = await client.query("SELECT * FROM projects WHERE id = $1", [projectId]);
    if (projRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Không tìm thấy project" });
    }
    const project = projRes.rows[0];
    const N = project.segment_count;
    const M = project.clips_per_segment;

    // Lấy tất cả cặp đã dùng
    const usedRes = await client.query(
      "SELECT segment_index, clip_current, clip_next FROM used_adjacent_pairs WHERE project_id = $1",
      [projectId]
    );
    const usedPairs = new Set(
      usedRes.rows.map(r => `${r.segment_index}-${r.clip_current}-${r.clip_next}`)
    );

    // Lấy tất cả biến thể để check trùng toàn bộ
    const variantsRes = await client.query(
      `SELECT v.id,
              json_agg(vs.clip_index ORDER BY vs.segment_index) AS clips
       FROM variants v
       JOIN variant_segments vs ON vs.variant_id = v.id
       WHERE v.project_id = $1
       GROUP BY v.id`,
      [projectId]
    );
    const existingVariants = variantsRes.rows.map(r => r.clips);

    const newVariant = new Array(N);
    let success = false;
    const MAX_TRIES_FOR_DUP = 20;

    function backtrack(pos) {
      if (pos === N) {
        // Check trùng nguyên video
        if (existingVariants.some(v => arraysEqual(v, newVariant))) {
          return false;
        }
        return true;
      }

      const candidates = shuffle(
        Array.from({ length: M }, (_, idx) => idx + 1)
      );

      for (const c of candidates) {
        if (pos > 0) {
          const prev = newVariant[pos - 1];
          const key = `${pos - 1}-${prev}-${c}`;
          if (usedPairs.has(key)) {
            continue; // cặp này đã dùng rồi
          }
        }

        newVariant[pos] = c;

        if (backtrack(pos + 1)) {
          return true;
        }
      }
      return false;
    }

    for (let attempt = 0; attempt < MAX_TRIES_FOR_DUP; attempt++) {
      if (backtrack(0)) {
        success = true;
        break;
      }
    }

    if (!success) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Không thể tạo thêm biến thể mới với rule hiện tại (hết combo hợp lệ).",
      });
    }

    // Tạo variant
    const countRes = await client.query(
      "SELECT COUNT(*) FROM variants WHERE project_id = $1",
      [projectId]
    );
    const currentCount = parseInt(countRes.rows[0].count, 10);
    // const variantName = `Video #${currentCount + 1}`;

    // const base = 10; // bắt đầu từ Video - 10
    const base = M;
const variantName = `Video - ${base + currentCount}`;


    const insertVariantRes = await client.query(
      `INSERT INTO variants (project_id, name)
       VALUES ($1, $2)
       RETURNING id, name, created_at`,
      [projectId, variantName]
    );
    const variant = insertVariantRes.rows[0];
    const variantId = variant.id;

    // Lưu variant_segments
    for (let i = 0; i < N; i++) {
      await client.query(
        `INSERT INTO variant_segments (variant_id, segment_index, clip_index)
         VALUES ($1, $2, $3)`,
        [variantId, i, newVariant[i]]
      );
    }

    // Cập nhật used_adjacent_pairs
    for (let i = 0; i < N - 1; i++) {
      const key = `${i}-${newVariant[i]}-${newVariant[i + 1]}`;
      if (!usedPairs.has(key)) {
        await client.query(
          `INSERT INTO used_adjacent_pairs (project_id, segment_index, clip_current, clip_next)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [projectId, i, newVariant[i], newVariant[i + 1]]
        );
        usedPairs.add(key);
      }
    }

    await client.query("COMMIT");

    res.json({
  variant: {
    id: variantId,
    name: variant.name,
    created_at: variant.created_at,
    segments: newVariant.map((c, idx) => ({
      segment_index: idx + 1,         // 1, 2, 3,...
      clip_index: c,                  // 1..M
      code: `${idx + 1}.${c}`         // "1.3", "2.5", ...
    })),
  },
});

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Lỗi server khi tạo biến thể" });
  } finally {
    client.release();
  }
});

// Xoá project
app.delete("/api/projects/:id", async (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  if (!projectId) {
    return res.status(400).json({ error: "projectId không hợp lệ" });
  }

  try {
    const result = await pool.query(
      "DELETE FROM projects WHERE id = $1 RETURNING id",
      [projectId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Không tìm thấy project để xoá" });
    }

    // ON DELETE CASCADE sẽ tự xoá variants, variant_segments, used_adjacent_pairs
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server khi xoá project" });
  }
});


const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server chạy trên port", port);
});
