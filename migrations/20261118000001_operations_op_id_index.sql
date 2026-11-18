-- Push checks that an op id is not already some other op's, in any partition (an op's fan-out
-- copies share its id). Without this index that check would scan the op log under the sync-write
-- lock.
CREATE INDEX operations_op_id_idx ON operations (op_id);
