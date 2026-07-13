-- ============================================================
-- Supabase 阶段A SQL：增加字段 + 安全 Trigger
-- 执行顺序：1.加字段 → 2.建函数 → 3.删旧Trigger → 4.建新Trigger
-- 
-- 使用方法：
--   1. 登录 Supabase 控制台
--   2. 进入 SQL Editor
--   3. 粘贴本文件全部内容并执行
--   4. 确认执行成功（查看输出和表结构）
--
-- 安全说明：
--   - 新字段全部允许为空，不破坏旧前端
--   - 旧前端不传新字段，不影响现有功能
--   - Trigger 使用 TG_OP 区分 INSERT/UPDATE，安全访问 OLD
-- ============================================================

-- Step 1: 增加字段（全部允许为空，不破坏旧前端）
ALTER TABLE history ADD COLUMN IF NOT EXISTS record_uid UUID;
ALTER TABLE history ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE history ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false;
ALTER TABLE history ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Step 2: 创建安全的 Trigger 函数（用 TG_OP 区分 INSERT / UPDATE）
CREATE OR REPLACE FUNCTION set_history_timestamps()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- INSERT: 没有 OLD，只设置 updated_at 和 deleted_at
    NEW.updated_at = now();

    IF COALESCE(NEW.is_deleted, false) = true THEN
      NEW.deleted_at = now();
    ELSE
      NEW.deleted_at = NULL;
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    -- UPDATE: 有 OLD，可安全比较
    NEW.updated_at = now();

    -- 首次软删除：is_deleted 从 false → true
    IF COALESCE(NEW.is_deleted, false) = true
       AND COALESCE(OLD.is_deleted, false) = false THEN
      NEW.deleted_at = now();

    -- 恢复记录：is_deleted 从 true → false
    ELSIF COALESCE(NEW.is_deleted, false) = false
          AND COALESCE(OLD.is_deleted, false) = true THEN
      NEW.deleted_at = NULL;
    END IF;

  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 3: 删除旧 Trigger（幂等）
DROP TRIGGER IF EXISTS history_set_updated_at ON history;
DROP TRIGGER IF EXISTS history_set_timestamps ON history;

-- Step 4: 创建新 Trigger
CREATE TRIGGER history_set_timestamps
  BEFORE INSERT OR UPDATE ON history
  FOR EACH ROW
  EXECUTE FUNCTION set_history_timestamps();

-- ============================================================
-- 验证（执行后检查）
-- ============================================================
-- 确认字段已创建：
--   SELECT column_name, data_type FROM information_schema.columns 
--   WHERE table_name = 'history' ORDER BY ordinal_position;
--
-- 确认 Trigger 已创建：
--   SELECT trigger_name, event_manipulation FROM information_schema.triggers 
--   WHERE event_object_table = 'history';
--
-- 确认旧前端仍能正常使用（插入一条测试记录验证）：
--   INSERT INTO history (user_id, encrypted_data, iv) 
--   VALUES ('test', 'test_data', 'test_iv') RETURNING *;
--   -- 确认 updated_at 自动设置，is_deleted 默认 false
--   DELETE FROM history WHERE user_id = 'test';

-- ============================================================
-- 阶段B SQL（在阶段A前端发布且迁移完成后执行）
-- ============================================================
-- 前置条件：
--   1. 所有云端记录均有 record_uid（SELECT count(*) FROM history WHERE record_uid IS NULL; 结果为 0）
--   2. 云端重复记录已处理
--   3. 用户已确认迁移完成
--
-- ALTER TABLE history ALTER COLUMN record_uid SET NOT NULL;
-- ALTER TABLE history ADD CONSTRAINT history_user_record_uid_key
--   UNIQUE (user_id, record_uid);
