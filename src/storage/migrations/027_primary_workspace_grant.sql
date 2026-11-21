-- 主工作目录：项目创建时的首个文件夹为主要目录（决定任务默认cwd），
-- 其余为附加目录（对齐 ZCode VirtualProject.roots={rootPath,isPrimary}[]）。
-- 存量项目回填：每个项目最早创建且未撤销的授权为主要目录。
ALTER TABLE workspace_grants ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0;
UPDATE workspace_grants SET is_primary = 1 WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at ASC, id ASC) AS rn
    FROM workspace_grants WHERE revoked_at IS NULL
  ) WHERE rn = 1
);
