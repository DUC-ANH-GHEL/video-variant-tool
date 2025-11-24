// const API_BASE = "http://localhost:3000/api";
const API_BASE = "/api";


// form & project detail
const projectNameInput = document.getElementById("projectName");
const segmentCountInput = document.getElementById("segmentCount");
const clipCountInput = document.getElementById("clipCount");
const projectIdInput = document.getElementById("projectId");
const projectInfoDiv = document.getElementById("projectInfo");

// project list
const projectsListEl = document.getElementById("projectsList");
const projectSearchInput = document.getElementById("projectSearch");
const projectPageInfo = document.getElementById("projectPageInfo");
const btnProjectSearch = document.getElementById("btnProjectSearch");
const btnProjectPrev = document.getElementById("btnProjectPrev");
const btnProjectNext = document.getElementById("btnProjectNext");

// variants
const variantsListEl = document.getElementById("variantsList");

// variant modal
const variantModal = document.getElementById("variantModal");
const variantModalTableHead = document.getElementById("variantModalTableHead");
const variantModalTableBody = document.getElementById("variantModalTableBody");
const variantCopyBtn = document.getElementById("variantCopy");
const variantStatusCheckbox = document.getElementById("variantStatusCheckbox");

let currentVariants = [];
let currentVariantIdInModal = null;

// buttons
const btnCreateProject = document.getElementById("btnCreateProject");
const btnLoadProject = document.getElementById("btnLoadProject");
const btnNewVariant = document.getElementById("btnNewVariant");

let currentProjectPage = 1;
let totalProjectPages = 1;
let currentProjectSearch = "";
let selectedProjectId = null;

// ---------- Helpers ----------
function showToast(message, type = "info") {
    const container = document.getElementById("toastContainer");
    const toast = document.createElement("div");
    toast.className = `toast toast--${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add("toast--hide");
        setTimeout(() => {
            toast.remove();
        }, 200);
    }, 2600);
}

function setButtonLoading(button, isLoading, loadingText) {
    if (!button) return;
    if (isLoading) {
        if (!button.dataset.originalText) {
            button.dataset.originalText = button.innerHTML;
        }
        button.classList.add("btn-loading");
        if (loadingText) {
            button.innerHTML = loadingText;
        }
        button.disabled = true;
    } else {
        button.classList.remove("btn-loading");
        if (button.dataset.originalText) {
            button.innerHTML = button.dataset.originalText;
            delete button.dataset.originalText;
        }
        button.disabled = false;
    }
}

// ---------- CREATE PROJECT ----------
btnCreateProject.addEventListener("click", async() => {
    const name = projectNameInput.value.trim();
    const segment_count = parseInt(segmentCountInput.value, 10);
    const clips_per_segment = parseInt(clipCountInput.value, 10);

    if (!name || !segment_count || !clips_per_segment) {
        showToast("Nhập đủ tên, số phân đoạn, số clip.", "error");
        return;
    }

    try {
        setButtonLoading(btnCreateProject, true, "Đang tạo...");
        const res = await fetch(`${API_BASE}/projects`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, segment_count, clips_per_segment }),
        });
        const data = await res.json();
        if (!res.ok) {
            showToast("Lỗi tạo project: " + (data.error || "Unknown"), "error");
            return;
        }
        projectIdInput.value = data.id;
        selectedProjectId = data.id;
        showToast("Tạo project thành công. ID = " + data.id, "success");
        await loadProjects(currentProjectPage);
        await loadProject();

        // 👇 Tạo luôn toàn bộ biến thể cho project vừa tạo
        await createAllVariantsForCurrentProject(true);
    } catch (err) {
        console.error(err);
        showToast("Lỗi gọi API khi tạo project.", "error");
    } finally {
        setButtonLoading(btnCreateProject, false);
    }
});

// ---------- LOAD 1 PROJECT & VARIANTS ----------
btnLoadProject.addEventListener("click", loadProject);

async function loadProject() {
    const projectId = parseInt(projectIdInput.value || selectedProjectId, 10);
    if (!projectId) {
        showToast("Nhập hoặc chọn Project ID trước.", "error");
        return;
    }
    try {
        setButtonLoading(btnLoadProject, true, "Đang load...");
        const res = await fetch(`${API_BASE}/projects/${projectId}`);
        const data = await res.json();
        if (!res.ok) {
            showToast(data.error || "Không load được project", "error");
            return;
        }

        const p = data.project;
        selectedProjectId = p.id;
        projectIdInput.value = p.id;

        projectInfoDiv.textContent =
            `Project: ${p.name} | ID: ${p.id} | Phân đoạn: ${p.segment_count} | ` +
            `Clip/đoạn: ${p.clips_per_segment} | Biến thể: ${data.variants.length}`;

        highlightSelectedProjectRow();
        renderVariants(data.variants);
        showToast("Load project thành công.", "success");
    } catch (err) {
        console.error(err);
        showToast("Lỗi gọi API khi load project.", "error");
    } finally {
        setButtonLoading(btnLoadProject, false);
    }
}


// ---------- VARIANTS RENDER ----------
function renderVariants(variants) {
    // lưu lại để modal dùng
    currentVariants = Array.isArray(variants) ? [...variants] : [];

    variantsListEl.innerHTML = "";
    if (!variants || variants.length === 0) {
        const empty = document.createElement("li");
        empty.className = "variant-empty";
        empty.textContent = "Chưa có biến thể nào.";
        variantsListEl.appendChild(empty);
        return;
    }

    // Sắp xếp lại cho chắc: ID giảm dần => mới nhất lên đầu
    const sorted = [...variants].sort((a, b) => b.id - a.id);
    const total = sorted.length;

    sorted.forEach((v, idx) => {
        // Video - 1 là cũ nhất, Video - N là mới nhất
        const videoNumber = total - idx;

        const li = document.createElement("li");
        li.className = "variant-row";
        li.dataset.variantId = v.id;

        li.dataset.variantName = v.name;

        const meta = document.createElement("div");
        meta.className = "variant-meta";

        // nếu chưa có status (dữ liệu cũ) thì mặc định coi là true
        const isOn = v.status !== false;
        const badgeClass = isOn ?
            "variant-badge variant-badge-on" :
            "variant-badge variant-badge-off";

        meta.innerHTML = `
    <span class="${badgeClass}">${v.name}</span>
    <span class="variant-id">ID ${v.id}</span>
`;
        li.appendChild(meta);


        const codes = v.segments
            .sort((a, b) => a.segment_index - b.segment_index)
            .map((s) => {
                const base = `${s.segment_index}.${s.clip_index}`;
                const label = formatEditLabel(s);
                return label ? `${base} (${label})` : base;
            })
            .join(", ");

        const codeEl = document.createElement("div");
        codeEl.className = "variant-code";
        codeEl.textContent = `[${codes}]`;
        li.appendChild(codeEl);




        // click cả dòng để mở modal
        li.addEventListener("click", () => {
            openVariantModal(v.id);
        });

        variantsListEl.appendChild(li);
    });
}


// ---------- VARIANT MODAL LOGIC ----------

function openVariantModal(variantId) {
    const idNum = Number(variantId);
    const variant = currentVariants.find((v) => v.id === idNum);
    if (!variant || !variantModal) return;

    currentVariantIdInModal = idNum;

    // set checkbox status theo variant
    if (variantStatusCheckbox) {
        variantStatusCheckbox.checked = !!variant.status;
    }

    // render bảng chi tiết segments
    const segments = [...variant.segments].sort(
        (a, b) => a.segment_index - b.segment_index
    );

    variantModalTableHead.innerHTML = `
        <tr>
            <th>Segment</th>
            <th>Clip</th>
            <th>Mã</th>
            <th>Kiểu edit</th>
        </tr>
    `;

    variantModalTableBody.innerHTML = segments
        .map((s) => {
            const base = `${s.segment_index}.${s.clip_index}`;
            const label = formatEditLabel(s);
            const code = label ? `${base} (${label})` : base;
            return `
                <tr>
                    <td>${s.segment_index}</td>
                    <td>${s.clip_index}</td>
                    <td>${code}</td>
                    <td>${label || ""}</td>
                </tr>
            `;
        })
        .join("");

    variantModal.classList.add("open");
    variantModal.setAttribute("aria-hidden", "false");
}

function closeVariantModal() {
    if (!variantModal) return;
    variantModal.classList.remove("open");
    variantModal.setAttribute("aria-hidden", "true");
    currentVariantIdInModal = null;
}

// click backdrop hoặc nút close để đóng
if (variantModal) {
    variantModal.addEventListener("click", (e) => {
        if (e.target.matches("[data-modal-close]")) {
            closeVariantModal();
        }
    });
}

// copy code trong modal
if (variantCopyBtn) {
    variantCopyBtn.addEventListener("click", () => {
        if (!currentVariantIdInModal) return;
        const variant = currentVariants.find(
            (v) => v.id === currentVariantIdInModal
        );
        if (!variant) return;

        const clipsStr = [...variant.segments]
            .sort((a, b) => a.segment_index - b.segment_index)
            .map((s) => {
                const base = `${s.segment_index}.${s.clip_index}`;
                const label = formatEditLabel(s);
                return label ? `${base} (${label})` : base;
            })
            .join(", ");

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard
                .writeText(clipsStr)
                .then(() => showToast("Đã copy mã biến thể.", "success"))
                .catch(() => showToast("Copy không thành công.", "error"));
        } else {
            showToast("Trình duyệt không hỗ trợ copy tự động.", "error");
        }
    });
}

// Confirmation modal helper
let confirmModalResolve = null;
let confirmModalEscapeHandler = null;

function showConfirmModal(title, message) {
    return new Promise((resolve) => {
        const confirmModal = document.getElementById('confirmModal');
        const confirmModalTitle = document.getElementById('confirmModalTitle');
        const confirmModalMessage = document.getElementById('confirmModalMessage');
        const confirmModalOk = document.getElementById('confirmModalOk');
        const confirmModalCancel = document.getElementById('confirmModalCancel');
        
        if (!confirmModal) {
            resolve(false);
            return;
        }
        
        confirmModalResolve = resolve;
        
        if (confirmModalTitle) confirmModalTitle.textContent = title;
        if (confirmModalMessage) confirmModalMessage.textContent = message;
        
        confirmModal.classList.add('open');
        confirmModal.setAttribute('aria-hidden', 'false');
        
        const handleOk = () => {
            closeConfirmModal();
            confirmModalResolve?.(true);
            confirmModalResolve = null;
        };
        
        const handleCancel = () => {
            closeConfirmModal();
            confirmModalResolve?.(false);
            confirmModalResolve = null;
        };
        
        const handleBackdropClick = (e) => {
            if (e.target.id === 'confirmModal') {
                handleCancel();
            }
        };
        
        // bind listeners
        confirmModalOk.onclick = handleOk;
        confirmModalCancel.onclick = handleCancel;
        confirmModal.onclick = handleBackdropClick;
        
        // cleanup on escape key
        confirmModalEscapeHandler = (e) => {
            if (e.key === 'Escape') {
                handleCancel();
            }
        };
        document.addEventListener('keydown', confirmModalEscapeHandler);
    });
}

function closeConfirmModal() {
    const confirmModal = document.getElementById('confirmModal');
    if (!confirmModal) return;
    confirmModal.classList.remove('open');
    confirmModal.setAttribute('aria-hidden', 'true');
    
    // remove escape listener
    if (confirmModalEscapeHandler) {
        document.removeEventListener('keydown', confirmModalEscapeHandler);
        confirmModalEscapeHandler = null;
    }
}

// khi thay đổi status trong modal => gọi API PATCH
if (variantStatusCheckbox) {
    // Use change event to detect toggle, but revert immediately if not confirmed
    variantStatusCheckbox.addEventListener("change", async(e) => {
        if (!currentVariantIdInModal) {
            console.warn("No variant ID in modal");
            return;
        }

        // The checkbox has already been toggled by the browser
        // We need to revert it immediately and ask for confirmation
        const attemptedStatus = variantStatusCheckbox.checked; // this is what user tried to set
        const currentStatus = !attemptedStatus; // revert to see what it was before
        
        // Revert the checkbox back to its original state
        variantStatusCheckbox.checked = currentStatus;
        
        const newStatus = attemptedStatus; // the status user is trying to set
        const variantId = currentVariantIdInModal;

        console.log("Status toggle attempted:", {
            currentStatus: currentStatus,
            newStatus: newStatus,
            variantId: variantId
        });

        // show custom confirmation modal
        const confirmTitle = newStatus ? "Xác nhận - TẠO" : "Xác nhận - BỎ";
        const confirmMsg = newStatus 
            ? "Bạn chắc chắn muốn đánh dấu biến thể này là đã tạo?" 
            : "Bạn chắc chắn muốn bỏ đánh dấu biến thể này?";
        
        const confirmed = await showConfirmModal(confirmTitle, confirmMsg);
        
        if (!confirmed) {
            console.log("Confirmation cancelled, checkbox stays at:", currentStatus);
            // user cancelled, checkbox already reverted
            return;
        }

        console.log("Confirmed, making API call with newStatus:", newStatus);

        try {
            const res = await fetch(
                `${API_BASE}/variants/${variantId}/status`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ status: newStatus }),
                }
            );
            const data = await res.json();
            if (!res.ok) {
                console.error("API error:", data);
                showToast(
                    data.error || "Cập nhật status biến thể thất bại.",
                    "error"
                );
                return;
            }

            console.log("API success, updating UI...");

            // update lại trong currentVariants
            const idx = currentVariants.findIndex((v) => v.id === variantId);
            if (idx !== -1) {
                currentVariants[idx] = {
                    ...currentVariants[idx],
                    status: data.status,
                };
            }

            // NOW set checkbox to the new confirmed status
            variantStatusCheckbox.checked = newStatus;

            // re-render list để checkbox ở list cập nhật
            renderVariants(currentVariants);

            // update màu cho modal checkbox nếu cần
            if (newStatus) {
                variantStatusCheckbox.parentElement.classList.add("checked");
                variantStatusCheckbox.parentElement.classList.remove("unchecked");
            } else {
                variantStatusCheckbox.parentElement.classList.add("unchecked");
                variantStatusCheckbox.parentElement.classList.remove("checked");
            }


            showToast(
                `Đã ${newStatus ? "bật" : "tắt"} status cho biến thể #${variantId}.`,
                "success"
            );

            // close modal after updating status
            closeVariantModal();
        } catch (err) {
            console.error("API call error:", err);
            showToast("Lỗi gọi API khi cập nhật status.", "error");
        }
    });
}



// ---------- TẠO BIẾN THỂ MỚI ----------

// ---------- HÀM CHUNG: TẠO TẤT CẢ BIẾN THỂ CHO PROJECT HIỆN TẠI ----------
async function createAllVariantsForCurrentProject(autoFromCreate = false) {
    const projectId = parseInt(projectIdInput.value || selectedProjectId, 10);
    if (!projectId) {
        // nếu gọi từ nút "Tạo biến thể" thì mới báo lỗi
        if (!autoFromCreate) {
            showToast("Chọn hoặc nhập Project ID trước.", "error");
        }
        return;
    }

    try {
        const loadingText = autoFromCreate ? "Đang tạo biến thể..." : "Đang tạo...";
        setButtonLoading(btnNewVariant, true, loadingText);

        const res = await fetch(`${API_BASE}/projects/${projectId}/variants`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
        });
        const data = await res.json();
        if (!res.ok) {
            showToast("Lỗi tạo biến thể: " + (data.error || "Unknown"), "error");
            return;
        }

        const count = data.count ?? (data.variants ? data.variants.length : 0);

        if (data.variants && data.variants.length > 0) {
            const first = data.variants[0];
            const clips = first.segments
                .sort((a, b) => a.segment_index - b.segment_index)
                .map((s) => `${s.segment_index}.${s.clip_index}`)
                .join(", ");

            if (count > 1) {
                showToast(`Tạo ${count} biến thể mới. Ví dụ: [${clips}]`, "success");
            } else {
                showToast(`Tạo biến thể mới: [${clips}]`, "success");
            }
        } else {
            showToast("Không tạo được biến thể mới nào.", "error");
        }

        // load lại project để list biến thể cập nhật
        await loadProject();
    } catch (err) {
        console.error(err);
        showToast("Lỗi gọi API khi tạo biến thể.", "error");
    } finally {
        setButtonLoading(btnNewVariant, false);
    }
}

btnNewVariant.addEventListener("click", () => {
    createAllVariantsForCurrentProject(false);
});

// btnNewVariant.addEventListener("click", async () => {
//     const projectId = parseInt(projectIdInput.value || selectedProjectId, 10);
//     if (!projectId) {
//         showToast("Chọn hoặc nhập Project ID trước.", "error");
//         return;
//     }

//     try {
//         setButtonLoading(btnNewVariant, true, "Đang tạo...");
//         const res = await fetch(`${API_BASE}/projects/${projectId}/variants`, {
//             method: "POST",
//             headers: { "Content-Type": "application/json" },
//         });
//         const data = await res.json();
//         if (!res.ok) {
//             showToast("Lỗi tạo biến thể: " + (data.error || "Unknown"), "error");
//             return;
//         }

//         const first = data.variants[0];
//         const clips = first.segments
//             .sort((a, b) => a.segment_index - b.segment_index)
//             .map((s) => `${s.segment_index}.${s.clip_index}`)
//             .join(", ");

//         showToast(`Tạo biến thể mới: [${clips}]`, "success");
//         await loadProject();
//     } catch (err) {
//         console.error(err);
//         showToast("Lỗi gọi API khi tạo biến thể.", "error");
//     } finally {
//         setButtonLoading(btnNewVariant, false);
//     }
// });

// ---------- PROJECT LIST + SEARCH + PAGINATION ----------
btnProjectSearch.addEventListener("click", () => {
    currentProjectPage = 1;
    currentProjectSearch = projectSearchInput.value.trim();
    loadProjects(currentProjectPage);
});

projectSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        currentProjectPage = 1;
        currentProjectSearch = projectSearchInput.value.trim();
        loadProjects(currentProjectPage);
    }
});

btnProjectPrev.addEventListener("click", () => {
    if (currentProjectPage > 1) {
        loadProjects(currentProjectPage - 1);
    }
});

btnProjectNext.addEventListener("click", () => {
    if (currentProjectPage < totalProjectPages) {
        loadProjects(currentProjectPage + 1);
    }
});

async function loadProjects(page = 1) {
    const search = projectSearchInput.value.trim();
    const limit = 8;
    try {
        setButtonLoading(btnProjectSearch, true, "Đang tìm...");
        const params = new URLSearchParams({
            page: page.toString(),
            limit: limit.toString(),
            search,
        });
        const res = await fetch(`${API_BASE}/projects?` + params.toString());
        const data = await res.json();
        if (!res.ok) {
            console.error(data);
            showToast(data.error || "Không load được danh sách project", "error");
            return;
        }

        currentProjectPage = data.pagination.page;
        totalProjectPages = data.pagination.totalPages || 1;
        projectPageInfo.textContent =
            `Trang ${currentProjectPage}/${totalProjectPages}`;

        // show total projects count if element exists
        const totalCountEl = document.getElementById('projectTotalCount');
        if (totalCountEl) {
            const totalProjects = data.pagination.total || 0;
            totalCountEl.textContent = `Tổng: ${totalProjects}`;
        }

        renderProjectList(data.projects);
        highlightSelectedProjectRow();
    } catch (err) {
        console.error(err);
        showToast("Lỗi gọi API danh sách project.", "error");
    } finally {
        setButtonLoading(btnProjectSearch, false);
    }
}

async function deleteProject(projectId, btnElement) {
    //   if (!confirm("Bạn chắc chắn muốn xoá project này? (Toàn bộ biến thể cũng sẽ bị xoá)")) {
    //     return;
    //   }
    const pass = prompt("Nhập mật khẩu để xoá project:");
    if (pass !== "7246") {
        showToast("Sai mật khẩu! Không thể xoá.", "error");
        return;
    }

    if (!confirm("Bạn chắc chắn muốn xoá project này? (Toàn bộ biến thể cũng sẽ bị xoá)")) {
        return;
    }

    try {
        btnElement.disabled = true;
        btnElement.textContent = "Đang xoá...";
        const res = await fetch(`${API_BASE}/projects/${projectId}`, {
            method: "DELETE",
        });
        const data = await res.json();
        if (!res.ok) {
            showToast(data.error || "Lỗi xoá project", "error");
            return;
        }

        showToast("Đã xoá project.", "success");

        // Nếu đang xem project này thì clear thông tin & variants
        if (selectedProjectId === projectId) {
            selectedProjectId = null;
            projectIdInput.value = "";
            projectInfoDiv.textContent = "Chưa chọn project.";
            variantsListEl.innerHTML = "";
            const empty = document.createElement("li");
            empty.className = "variant-empty";
            empty.textContent = "Chưa chọn project nào.";
            variantsListEl.appendChild(empty);
        }

        // Reload lại list project (vẫn giữ trang hiện tại)
        await loadProjects(currentProjectPage);
    } catch (err) {
        console.error(err);
        showToast("Lỗi gọi API khi xoá project.", "error");
    } finally {
        btnElement.disabled = false;
        btnElement.textContent = "Xoá";
    }
}




function renderProjectList(projects) {
    projectsListEl.innerHTML = "";
    if (!projects || projects.length === 0) {
        const li = document.createElement("li");
        li.className = "project-empty";
        li.textContent = "Không có project nào.";
        projectsListEl.appendChild(li);
        return;
    }

    projects.forEach((p) => {
        const li = document.createElement("li");
        li.className = "project-row";
        li.dataset.projectId = p.id;

        // header: tên + nút xoá
        const header = document.createElement("div");
        header.className = "project-row-header";

        const title = document.createElement("div");
        title.className = "project-row-title";
        title.textContent = p.name;

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "btn-outline small-btn project-delete-btn";
        deleteBtn.textContent = "Xoá";
        deleteBtn.addEventListener("click", (e) => {
            e.stopPropagation(); // không trigger click chọn project
            deleteProject(p.id, deleteBtn);
        });

        header.appendChild(title);
        header.appendChild(deleteBtn);
        li.appendChild(header);

        // meta
        const meta = document.createElement("div");
        meta.className = "project-row-meta";
        const variantInfo = p.total_variants ? `${p.completed_variants}/${p.total_variants} biến thể DONE` : "0/0 biến thể DONE";
        meta.textContent = `ID ${p.id} • ${p.segment_count} đoạn • ${p.clips_per_segment} clip/đoạn • ${variantInfo}`;
        li.appendChild(meta);

        // click vào cả row để chọn project
        li.addEventListener("click", () => {
            selectedProjectId = p.id;
            projectIdInput.value = p.id;
            highlightSelectedProjectRow();
            loadProject();
        });

        projectsListEl.appendChild(li);
    });
}


function highlightSelectedProjectRow() {
    const rows = projectsListEl.querySelectorAll(".project-row");
    rows.forEach((row) => {
        const id = parseInt(row.dataset.projectId, 10);
        row.classList.toggle("active", id === selectedProjectId);
    });
}

function formatEditLabel(seg) {
    if (seg.edit_type === 'zoom_fixed') return 'phóng to';
    if (seg.edit_type === 'keyframe') {
        const parts = [];
        if (seg.kf_scale >= 2) parts.push(`tỉ lệ×${seg.kf_scale}`);
        if (seg.kf_position >= 2) parts.push(`vị trí×${seg.kf_position}`);
        if (seg.kf_rotate >= 2) parts.push(`xoay×${seg.kf_rotate}`);
        return parts.length ? parts.join(', ') : 'keyframe';
    }
    return '';
}



// load list project lần đầu
loadProjects(1);