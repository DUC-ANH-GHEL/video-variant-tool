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
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i]) return false;
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
app.post("/api/projects", async(req, res) => {
    try {
        const { name, segment_count, clips_per_segment } = req.body;
        if (!name || !segment_count || !clips_per_segment) {
            return res.status(400).json({ error: "Thiếu name / segment_count / clips_per_segment" });
        }

        const result = await pool.query(
            `INSERT INTO projects (name, segment_count, clips_per_segment)
       VALUES ($1, $2, $3)
       RETURNING id, name, segment_count, clips_per_segment, created_at`, [name, segment_count, clips_per_segment]
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Lỗi server khi tạo project" });
    }
});

app.get("/api/projects", async(req, res) => {
    const page = parseInt(req.query.page || "1", 10);
    const limit = parseInt(req.query.limit || "10", 10);
    const search = (req.query.search || "").trim();

    const offset = (page - 1) * limit;

    try {
        let countRes, listRes;

        if (search) {
            countRes = await pool.query(
                `SELECT COUNT(*) FROM projects
         WHERE name ILIKE '%' || $1 || '%' OR CAST(id AS TEXT) = $1`, [search]
            );
            listRes = await pool.query(
                `SELECT * FROM projects
         WHERE name ILIKE '%' || $1 || '%' OR CAST(id AS TEXT) = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`, [search, limit, offset]
            );
        } else {
            countRes = await pool.query("SELECT COUNT(*) FROM projects");
            listRes = await pool.query(
                `SELECT * FROM projects
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`, [limit, offset]
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
app.get("/api/projects/:id", async(req, res) => {
    const projectId = parseInt(req.params.id, 10);
    if (!projectId) return res.status(400).json({ error: "projectId không hợp lệ" });

    try {
        const projectRes = await pool.query(
            "SELECT * FROM projects WHERE id = $1", [projectId]
        );
        if (projectRes.rows.length === 0) {
            return res.status(404).json({ error: "Không tìm thấy project" });
        }


        const variantsRes = await pool.query(
            `SELECT 
          v.id,
          v.name,
          v.status,
          v.created_at,
          json_agg(
            json_build_object(
              'segment_index', vs.segment_index + 1,
              'clip_index',    vs.clip_index,
              'edit_type',     coalesce(vse.edit_type, 'none'),
              'kf_scale',      coalesce(vse.kf_scale, 0),
              'kf_position',   coalesce(vse.kf_position, 0),
              'kf_rotate',     coalesce(vse.kf_rotate, 0)
            )
            ORDER BY vs.segment_index
          ) AS segments
     FROM variants v
     JOIN variant_segments vs ON vs.variant_id = v.id
     LEFT JOIN variant_segment_edits vse 
           ON vse.variant_id = v.id AND vse.segment_index = vs.segment_index
     WHERE v.project_id = $1
     GROUP BY v.id, v.name, v.status, v.created_at
     ORDER BY v.id DESC
     `, [projectId]
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

// Sinh thông số edit cho N phân đoạn, dựa trên edit của biến thể trước đó
// lastVariantEdits: Map { segment_index: { type, s, p, r } }
function buildEditsForVariant(N, lastVariantEdits) {
    const edits = [];

    for (let i = 0; i < N; i++) {
        const prev = lastVariantEdits ? lastVariantEdits[i] : null;

        // Chưa có edit trước đó => phóng to cố định
        if (!prev) {
            edits.push({ type: "zoom_fixed", s: 0, p: 0, r: 0 });
            continue;
        }

        // Nếu lần trước là phóng to -> lần này chuyển sang keyframe tỉ lệ×2
        if (prev.type === "zoom_fixed") {
            edits.push({
                type: "keyframe",
                s: 2, // tỉ lệ×2
                p: 0,
                r: 0,
            });
            continue;
        }

        // Lần trước là keyframe thì tăng dần
        // Luôn có scale, pos/rot chỉ khi trước đó đã bật
        const nextScale = prev.s > 0 ? prev.s + 1 : 2;

        const nextPos = prev.p > 0 ? prev.p + 1 : 0;
        const nextRot = prev.r > 0 ? prev.r + 1 : 0;

        edits.push({
            type: "keyframe",
            s: nextScale,
            p: nextPos,
            r: nextRot,
        });
    }

    return edits;
}

// prev: null hoặc { type, s, p, r }
function getNextEdit(prev) {
    // Chưa từng dùng clip này => phóng to cố định
    if (!prev || prev.type === "none") {
        return { type: "zoom_fixed", s: 0, p: 0, r: 0 };
    }

    // Lần trước là phóng to => lần này sang keyframe tỉ lệ×2
    if (prev.type === "zoom_fixed") {
        return { type: "keyframe", s: 2, p: 0, r: 0 };
    }

    // Safety: nếu không phải keyframe thì reset về tỉ lệ×2
    if (prev.type !== "keyframe") {
        return { type: "keyframe", s: 2, p: 0, r: 0 };
    }

    let s = prev.s || 0; // scale
    let p = prev.p || 0; // position
    let r = prev.r || 0; // rotate

    // Nếu dữ liệu cũ bị lỗi (s < 2) thì reset về tỉ lệ×2
    if (s < 2) {
        return { type: "keyframe", s: 2, p: 0, r: 0 };
    }

    // ------- BẬC 2: đi đúng chuỗi bạn yêu cầu -------
    // tỉ lệ×2 -> tỉ lệ×2, vị trí×2 -> tỉ lệ×2, vị trí×2, xoay×2 -> tỉ lệ×3
    if (s === 2) {
        const pattern2 = [
            { s: 2, p: 0, r: 0 }, // tỉ lệ×2
            { s: 2, p: 2, r: 0 }, // tỉ lệ×2, vị trí×2
            { s: 2, p: 2, r: 2 }, // tỉ lệ×2, vị trí×2, xoay×2
        ];
        const idx = pattern2.findIndex(st => st.s === s && st.p === p && st.r === r);
        if (idx === -1 || idx === pattern2.length - 1) {
            // sang bậc 3
            return { type: "keyframe", s: 3, p: 0, r: 0 };
        }
        const nxt = pattern2[idx + 1];
        return { type: "keyframe", s: nxt.s, p: nxt.p, r: nxt.r };
    }

    // ------- BẬC >=3: tối ưu số lượng như bạn nói -------
    // Ví dụ với s=3:
    //  tỉ lệ×3
    //  -> tỉ lệ×3, vị trí×2
    //  -> tỉ lệ×3, vị trí×2, xoay×2
    //  -> tỉ lệ×3, vị trí×3
    //  -> tỉ lệ×3, vị trí×3, xoay×2
    //  -> tỉ lệ×3, vị trí×3, xoay×3
    //  -> tỉ lệ×4 (và lặp pattern tương tự cho bậc tiếp theo)
    const pattern = [
        { s, p: 0, r: 0 }, // tỉ lệ×s
        { s, p: 2, r: 0 }, // tỉ lệ×s, vị trí×2
        { s, p: 2, r: 2 }, // tỉ lệ×s, vị trí×2, xoay×2
        { s, p: s, r: 0 }, // tỉ lệ×s, vị trí×s
        { s, p: s, r: 2 }, // tỉ lệ×s, vị trí×s, xoay×2
        { s, p: s, r: s }, // tỉ lệ×s, vị trí×s, xoay×s
    ];

    let idx = pattern.findIndex(st => st.s === s && st.p === p && st.r === r);
    if (idx === -1 || idx === pattern.length - 1) {
        // Hết mọi combo ở bậc s -> tăng bậc tỉ lệ
        return { type: "keyframe", s: s + 1, p: 0, r: 0 };
    }
    const nxt = pattern[idx + 1];
    return { type: "keyframe", s: nxt.s, p: nxt.p, r: nxt.r };
}



// ================= TẠO NHIỀU BIẾN THỂ, ĐỒNG BỘ KIỂU EDIT ================
app.post("/api/projects/:id/variants", async(req, res) => {
    const projectId = parseInt(req.params.id, 10);
    if (!projectId) {
        return res.status(400).json({ error: "projectId không hợp lệ" });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Lấy project
        const projRes = await client.query(
            "SELECT * FROM projects WHERE id = $1", [projectId]
        );
        if (projRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "Không tìm thấy project" });
        }
        const project = projRes.rows[0];
        const N = project.segment_count; // số phân đoạn
        const M = project.clips_per_segment; // số clip / phân đoạn

        // 2. Lấy các cặp clip liền kề đã dùng
        const usedRes = await client.query(
            "SELECT segment_index, clip_current, clip_next FROM used_adjacent_pairs WHERE project_id = $1", [projectId]
        );
        const usedPairsFromDb = new Set(
            usedRes.rows.map(r => `${r.segment_index}-${r.clip_current}-${r.clip_next}`)
        );

        // 3. Lấy lịch sử edit theo từng (segment_index, clip_index)
        //    để biết "level" hiện tại của từng cảnh.
        //
        // Định nghĩa level:
        //   0: phóng to          (zoom)
        //   1: tỉ lệ×2           (scale 2, không vị trí)
        //   2: tỉ lệ×2 + vị trí×2 (scale 2 + position 2)
        //
        // Các kiểu khác (nếu có dữ liệu cũ) coi như đã lên level cao nhất.
        const historyRes = await client.query(
            `SELECT vs.segment_index,
              vs.clip_index,
              vse.edit_type,
              vse.kf_scale,
              vse.kf_position
       FROM variant_segment_edits vse
       JOIN variant_segments vs
         ON vs.variant_id = vse.variant_id
        AND vs.segment_index = vse.segment_index
       JOIN variants v
         ON v.id = vse.variant_id
       WHERE v.project_id = $1
       ORDER BY v.id`, [projectId]
        );

        const currentLevel = new Map(); // key = "segment-clip" -> level (0,1,2,...)



        function detectLevel(row) {
            if (!row) return -1;
            const type = row.edit_type;
            const s = row.kf_scale || 0;
            const p = row.kf_position || 0;

            // level 0: phóng to cố định
            if (type === "zoom_fixed") return 0;

            // level 1: tỉ lệ×2 (không dịch chuyển)
            if (type === "keyframe" && s === 2 && p === 0) return 1;

            // level 2: tỉ lệ×2 + vị trí×2
            if (type === "keyframe" && s === 2 && p === 2) return 2;

            // các kiểu khác coi như đã lên level cao nhất
            return 2;
        }


        for (const row of historyRes.rows) {
            const key = `${row.segment_index}-${row.clip_index}`;
            currentLevel.set(key, detectLevel(row));
        }

        // helper: trả về level tiếp theo cho (segment,clip)
        function nextLevelFor(segIndex, clipIndex) {
            const key = `${segIndex}-${clipIndex}`;
            const lv = currentLevel.has(key) ? currentLevel.get(key) : -1;
            const nextLv = Math.min(lv + 1, 2); // 0 -> 1 -> 2, max 2
            return nextLv;
        }

        // helper: build object edit theo level


        function buildEdit(level) {
            if (level <= 0) {
                // level 0: phóng to cố định
                return { type: "zoom_fixed", s: 0, p: 0, r: 0 };
            }
            if (level === 1) {
                // level 1: tỉ lệ×2
                return { type: "keyframe", s: 2, p: 0, r: 0 };
            }
            // level >= 2: tỉ lệ×2, vị trí×2 (không dùng xoay nữa => r = 0)
            return { type: "keyframe", s: 2, p: 2, r: 0 };
        }


        // 4. Lấy toàn bộ biến thể đã có để tránh trùng full video
        const variantsRes = await client.query(
            `SELECT v.id,
              json_agg(vs.clip_index ORDER BY vs.segment_index) AS clips
       FROM variants v
       JOIN variant_segments vs ON vs.variant_id = v.id
       WHERE v.project_id = $1
       GROUP BY v.id`, [projectId]
        );
        const existingVariants = variantsRes.rows.map(r => r.clips);

        const MAX_NEW_VARIANTS = 200; // giới hạn an toàn
        const generatedVariants = []; // mảng { clips: [...], level }

        // copy local cho usedPairs & existingVariants
        const usedPairs = new Set(usedPairsFromDb);
        const allVariantsClips = existingVariants.map(v => [...v]);

        // ---------- GEN 1 BIẾN THỂ Ở LEVEL CỤ THỂ ----------
        function generateOneVariantAtLevel(targetLevel) {
            const clips = new Array(N);

            // với mỗi segment, chỉ chọn các clip có nextLevel == targetLevel
            const candidateClipsPerSegment = [];
            for (let seg = 0; seg < N; seg++) {
                const cands = [];
                for (let c = 1; c <= M; c++) {
                    if (nextLevelFor(seg, c) === targetLevel) {
                        cands.push(c);
                    }
                }
                if (cands.length === 0) {
                    // segment này không còn clip nào ở level target => không gen được video ở level này
                    return null;
                }
                candidateClipsPerSegment[seg] = shuffle(cands);
            }

            function backtrack(pos) {
                if (pos === N) {
                    // check trùng full
                    if (allVariantsClips.some(v => arraysEqual(v, clips))) {
                        return false;
                    }
                    return true;
                }

                const cands = candidateClipsPerSegment[pos];
                for (const c of cands) {
                    if (pos > 0) {
                        const prevClip = clips[pos - 1];
                        const key = `${pos - 1}-${prevClip}-${c}`;
                        if (usedPairs.has(key)) continue;
                    }

                    clips[pos] = c;
                    if (backtrack(pos + 1)) return true;
                }
                return false;
            }

            const ok = backtrack(0);
            if (!ok) return null;

            // cập nhật local state
            const copy = clips.slice();
            allVariantsClips.push(copy);
            for (let i = 0; i < N - 1; i++) {
                const key = `${i}-${copy[i]}-${copy[i + 1]}`;
                usedPairs.add(key);
            }

            return copy;
        }

        // 5. Sinh TẤT CẢ biến thể:
        //    - ưu tiên level 0 (phóng to) cho tới khi không gen được nữa
        //    - sau đó level 1 (tỉ lệ×2)
        //    - rồi level 2 (tỉ lệ×2 + vị trí×2)
        const MAX_LEVEL = 2;



        // Lần lượt: sinh hết level 0 (phóng to) -> hết level 1 (tỉ lệ×2) -> hết level 2 (tỉ lệ×2 + vị trí×2)
        for (let lvl = 0; lvl <= MAX_LEVEL; lvl++) {
            while (generatedVariants.length < MAX_NEW_VARIANTS) {
                const vClips = generateOneVariantAtLevel(lvl);
                if (!vClips) {
                    // không còn combo hợp lệ ở level này nữa -> chuyển sang level tiếp theo
                    break;
                }

                generatedVariants.push({ clips: vClips, level: lvl });

                // update currentLevel cho các cảnh đã dùng ở level này
                for (let seg = 0; seg < N; seg++) {
                    const cIdx = vClips[seg];
                    const key = `${seg}-${cIdx}`;
                    const newLv = lvl;
                    const oldLv = currentLevel.has(key) ? currentLevel.get(key) : -1;
                    if (newLv > oldLv) currentLevel.set(key, newLv);
                }
            }
        }


        if (generatedVariants.length === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({
                error: "Không thể tạo thêm biến thể mới với rule hiện tại (hết combo hợp lệ).",
            });
        }

        // 6. Đếm số biến thể hiện có để đặt tên tiếp
        const countRes = await client.query(
            "SELECT COUNT(*) FROM variants WHERE project_id = $1", [projectId]
        );
        const currentCount = parseInt(countRes.rows[0].count, 10);
        const base = M + 1;

        const responseVariants = [];

        // 7. Ghi xuống DB tất cả biến thể mới
        for (let idx = 0; idx < generatedVariants.length; idx++) {
            const { clips, level } = generatedVariants[idx];

            const variantName = `Video - ${base + currentCount + idx}`;
            const insertVariantRes = await client.query(
                `INSERT INTO variants (project_id, name)
         VALUES ($1, $2)
         RETURNING id, name, created_at`, [projectId, variantName]
            );
            const variant = insertVariantRes.rows[0];
            const variantId = variant.id;

            // lưu variant_segments
            for (let seg = 0; seg < N; seg++) {
                await client.query(
                    `INSERT INTO variant_segments (variant_id, segment_index, clip_index)
           VALUES ($1, $2, $3)`, [variantId, seg, clips[seg]]
                );
            }

            // build edit theo level (dùng chung cho TẤT CẢ phân đoạn của video này)
            const e = buildEdit(level);

            const segmentsOut = [];
            for (let seg = 0; seg < N; seg++) {
                await client.query(
                    `INSERT INTO variant_segment_edits (variant_id, segment_index, edit_type, kf_scale, kf_position, kf_rotate)
           VALUES ($1, $2, $3, $4, $5, $6)`, [variantId, seg, e.type, e.s, e.p, e.r] // r luôn = 0, không dùng xoay nữa
                );

                segmentsOut.push({
                    segment_index: seg + 1,
                    clip_index: clips[seg],
                    code: `${seg + 1}.${clips[seg]}`,
                    edit_type: e.type,
                    kf_scale: e.s,
                    kf_position: e.p,
                    kf_rotate: e.r,
                });
            }

            // cập nhật used_adjacent_pairs xuống DB
            for (let i = 0; i < N - 1; i++) {
                await client.query(
                    `INSERT INTO used_adjacent_pairs (project_id, segment_index, clip_current, clip_next)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`, [projectId, i, clips[i], clips[i + 1]]
                );
            }

            responseVariants.push({
                id: variantId,
                name: variant.name,
                created_at: variant.created_at,
                segments: segmentsOut,
            });
        }

        await client.query("COMMIT");

        res.json({
            variants: responseVariants,
            count: responseVariants.length,
        });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error(err);
        res.status(500).json({ error: "Lỗi server khi tạo các biến thể" });
    } finally {
        client.release();
    }
});



// Xoá project
app.delete("/api/projects/:id", async(req, res) => {
    const projectId = parseInt(req.params.id, 10);
    if (!projectId) {
        return res.status(400).json({ error: "projectId không hợp lệ" });
    }

    try {
        const result = await pool.query(
            "DELETE FROM projects WHERE id = $1 RETURNING id", [projectId]
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

// Lấy status của tất cả biến thể trong 1 project
app.get("/api/projects/:id/variants-status", async(req, res) => {
    const projectId = parseInt(req.params.id, 10);
    if (!projectId) {
        return res.status(400).json({ error: "projectId không hợp lệ" });
    }

    try {
        const rs = await pool.query(
            "SELECT id, status FROM variants WHERE project_id = $1 ORDER BY id DESC", [projectId]
        );
        res.json(rs.rows); // [{ id, status }, ...]
    } catch (err) {
        console.error(err);
        res
            .status(500)
            .json({ error: "Lỗi server khi lấy status danh sách biến thể" });
    }
});


// Cập nhật status cho 1 biến thể
app.patch("/api/variants/:id/status", async(req, res) => {
    const variantId = parseInt(req.params.id, 10);
    const { status } = req.body;

    if (!variantId) {
        return res.status(400).json({ error: "variantId không hợp lệ" });
    }
    if (typeof status !== "boolean") {
        return res.status(400).json({ error: "status phải là boolean (true/false)" });
    }

    try {
        const rs = await pool.query(
            "UPDATE variants SET status = $1 WHERE id = $2 RETURNING id, status", [status, variantId]
        );
        if (rs.rowCount === 0) {
            return res.status(404).json({ error: "Không tìm thấy biến thể" });
        }
        res.json(rs.rows[0]); // { id, status }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Lỗi server khi cập nhật status biến thể" });
    }
});



const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log("Server chạy trên port", port);
});