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

-- Step 5: 创建只读 RPC 函数（v1.6.2: 无副作用约束检查）
-- 返回 record_uid 列的 NOT NULL 状态和 UNIQUE(user_id, record_uid) 约束状态
-- 使用 information_schema 和 pg_catalog 只读检查，不插入/更新/删除任何数据
CREATE OR REPLACE FUNCTION get_history_sync_constraints()
RETURNS JSON AS $$
DECLARE
  result JSON;
  col_not_null BOOLEAN := false;
  constr_ready BOOLEAN := false;
BEGIN
  -- 检查 record_uid 列是否 NOT NULL
  SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'history'
      AND column_name = 'record_uid'
      AND is_nullable = 'NO'
  ) INTO col_not_null;

  -- 检查 UNIQUE(user_id, record_uid) 约束是否存在
  -- 检查名为 history_user_record_uid_key 的唯一约束
  SELECT EXISTS(
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.history'::regclass
      AND contype = 'u'
      AND conname = 'history_user_record_uid_key'
  ) INTO constr_ready;

  -- 如果按名称没找到，再按列组合检查
  IF NOT constr_ready THEN
    SELECT EXISTS(
      SELECT 1 FROM pg_constraint pc
      JOIN pg_class c ON c.oid = pc.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'history'
        AND pc.contype = 'u'
        AND array_to_string(pc.conkey, ',') IN ('1,5', '5,1')
        -- conkey 是列序号数组，user_id 通常是第1列，record_uid 是新加的列
    ) INTO constr_ready;
  END IF;

  result := json_build_object(
    'record_uid_not_null', col_not_null,
    'unique_constraint_ready', constr_ready
  );

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog;

-- 授予 anon 和 authenticated 角色调用权限
GRANT EXECUTE ON FUNCTION get_history_sync_constraints() TO anon, authenticated;

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
-- 确认 RPC 函数已创建：
--   SELECT get_history_sync_constraints();
--   -- 应返回 {"record_uid_not_null": false, "unique_constraint_ready": false}
--   -- （阶段A后、阶段B前，两个约束都还没建立）
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
-- 执行以下 SQL 启用唯一约束：
-- ALTER TABLE history ALTER COLUMN record_uid SET NOT NULL;
-- ALTER TABLE history ADD CONSTRAINT history_user_record_uid_key
--   UNIQUE (user_id, record_uid);
--
-- 安全回滚（如需）：
-- ALTER TABLE history DROP CONSTRAINT IF EXISTS history_user_record_uid_key;
-- ALTER TABLE history ALTER COLUMN record_uid DROP NOT NULL;
-- DROP TRIGGER IF EXISTS history_set_timestamps ON history;
