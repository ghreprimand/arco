import assert from 'node:assert/strict';

// Runs against an isolated container whose Codex binary is a protocol fixture
// and whose configured Ollama endpoint is a host-served protocol fixture. The
// provider adapters, cluster MCP child, stores and HTTP/WS handlers are real.
export async function clusterSmoke({ connect, disconnect, send, api, hostModel }) {
  let waitFor = await connect();
  await waitFor(message => message.type === 'connected');
  send({ type: 'create_workflow', config: { name: 'Cluster coordinator fixture', primaryProvider: 'codex', primaryModel: 'gpt-5.5', primaryEffort: 'low', codexTransport: 'appserver', workingDirectory: '/projects', skipPermissions: false } });
  const created = await waitFor(message => message.type === 'workflow_created');
  const coordinator = created.workflowId;
  send({ type: 'cluster_create_with_fresh_workers', sourceWorkflowId: coordinator, additionalCount: 1, name: 'Container cluster fixture' });
  const cluster = await waitFor(message => message.type === 'cluster_created');
  const id = cluster.clusterId;
  const worker = cluster.state.members.find(member => member.workflowId !== coordinator).workflowId;
  assert.equal(cluster.state.members.length, 2);
  // New clusters default to a cluster-local board; the task tools below use it.
  assert.equal(cluster.state.taskBoardMode, 'cluster');
  send({ type: 'cluster_plan_set', clusterId: id, body: '# ARCO_FIXTURE_PLAN\n\n- [ ] Edit the synthetic project file.\n' });
  await waitFor(message => message.type === 'cluster_plan_changed' && message.clusterId === id);
  send({ type: 'cluster_member_role_set', clusterId: id, workflowId: coordinator, role: 'Coordinator' });
  send({ type: 'cluster_member_role_set', clusterId: id, workflowId: worker, role: 'Reviewer' });
  // Explicitly choose the second member's transport as an operator would.
  send({ type: 'update_primary_config', workflowId: worker, codexTransport: 'appserver' });
  // Mixed-provider membership: the operator opens a tab on the host-served
  // model, arms its tool execution at creation, and adds it to the cluster.
  send({ type: 'create_workflow', config: { name: 'Host model fixture', primaryProvider: 'ollama', primaryModel: hostModel, primaryEffort: 'low', workingDirectory: '/projects', skipPermissions: true } });
  const local = (await waitFor(message => message.type === 'workflow_created' && message.config.primaryProvider === 'ollama')).workflowId;
  send({ type: 'cluster_member_add', clusterId: id, workflowId: local });
  await waitFor(message => message.type === 'cluster_member_added' && message.clusterId === id && message.member.workflowId === local);
  send({ type: 'cluster_member_role_set', clusterId: id, workflowId: local, role: 'Local reporter' });
  send({ type: 'user_message', workflowId: coordinator, content: 'ARCO_SMOKE_COORDINATE' });
  const ask = await waitFor(message => message.type === 'operator_question' && message.workflowId === coordinator && message.question?.status === 'pending');
  const claimed = await api(`/api/clusters/${id}/peer/task-list?workflowId=${coordinator}`);
  const tasks = await claimed.json();
  const task = tasks.tasks.find(task => task.title === 'Fixture mounted-file edit');
  assert.ok(task?.id);
  assert.equal(task.status, 'in_progress');
  assert.equal(task.assignee, coordinator);
  const stolen = await api(`/api/clusters/${id}/peer/task-claim`, { method: 'POST', body: JSON.stringify({ workflowId: worker, id: task.id }) });
  assert.equal(stolen.status, 400);
  assert.equal((await stolen.json()).error, 'already_claimed');

  await disconnect();
  waitFor = await connect();
  await waitFor(message => message.type === 'connected');
  send({ type: 'rehydrate_workflows', workflows: [{ workflowId: coordinator, config: created.config, currentSessionId: ask.question.threadId, lastSeq: ask.seq }] });
  const snapshot = await waitFor(message => message.type === 'workflow_state_snapshot' && message.workflowId === coordinator);
  assert.equal(snapshot.busy, true);
  assert.equal(snapshot.operatorQuestions[0].requestId, ask.question.requestId);
  send({ type: 'cluster_subscribe', clusterId: id });
  await waitFor(message => message.type === 'cluster_state' && message.clusterId === id);
  send({ type: 'operator_question_reply', workflowId: coordinator, requestId: ask.question.requestId, answers: { finish: ['Finish'] } });
  await waitFor(message => message.type === 'primary_text' && message.workflowId === coordinator && message.text.includes('ARCO_FIXTURE_COMPLETED'));
  await waitFor(message => message.type === 'primary_turn_ended' && message.workflowId === coordinator);
  const completed = await (await api(`/api/clusters/${id}/peer/task-show?workflowId=${coordinator}&id=${task.id}`)).json();
  assert.equal(completed.task.status, 'review');
  const selfAccept = await api(`/api/clusters/${id}/peer/task-update`, { method: 'POST', body: JSON.stringify({ workflowId: coordinator, id: task.id, status: 'done' }) });
  assert.equal(selfAccept.status, 400);
  console.log('PASS: compiled cluster MCP tools, plan, task ownership, active reconnect and operator-only acceptance');

  send({ type: 'user_message', workflowId: worker, content: 'ARCO_SMOKE_READ' });
  await waitFor(message => message.type === 'primary_text' && message.workflowId === worker && message.text.includes('ARCO_FIXTURE_MAILBOX_RECEIVED'));
  await waitFor(message => message.type === 'primary_turn_ended' && message.workflowId === worker);
  // The host-served member reads the coordinator's note through the in-process
  // Ollama adapter and answers the coordinator by role through the peer routes.
  send({ type: 'user_message', workflowId: local, content: 'ARCO_SMOKE_HOST_REPORT' });
  const ack = await waitFor(message => message.type === 'peer_message_sent' && message.workflowId === local);
  assert.equal(ack.to, coordinator);
  assert.match(ack.contentPreview, /ARCO_FIXTURE_HOST_ACK/);
  await waitFor(message => message.type === 'primary_text' && message.workflowId === local && message.text.includes('ARCO_FIXTURE_HOST_DONE'));
  await waitFor(message => message.type === 'primary_turn_ended' && message.workflowId === local);
  send({ type: 'user_message', workflowId: coordinator, content: 'ARCO_SMOKE_READ_HOST' });
  await waitFor(message => message.type === 'primary_text' && message.workflowId === coordinator && message.text.includes('ARCO_FIXTURE_HOST_ACK_RECEIVED'));
  await waitFor(message => message.type === 'primary_turn_ended' && message.workflowId === coordinator);
  console.log('PASS: host-served model member exchanged peer messages with the Codex coordinator');
  send({ type: 'review_request', workflowId: coordinator, reviewer: { provider: 'codex', model: 'gpt-5.5', effort: 'low' }, contextRef: { kind: 'last-turn' } });
  const started = await waitFor(message => message.type === 'review_started' && message.workflowId === coordinator);
  const review = await waitFor(message => message.type === 'review_artifact_ready' && message.reviewId === started.reviewId);
  assert.ok(!review.error, review.error);
  assert.ok(review.artifactName);
  // The operator board control addresses the cluster-local board by its key.
  send({ type: 'task_ledger_update', workflowId: coordinator, boardKey: `cluster:${id}`, id: task.id, status: 'done' });
  await waitFor(message => message.type === 'task_ledger_snapshot' && message.boardKey === `cluster:${id}` && message.tasks?.some(item => item.id === task.id && item.status === 'done'));
  console.log('PASS: peer delivery, isolated review artifact and operator task acceptance');

  send({ type: 'user_message', workflowId: worker, content: 'ARCO_SMOKE_CANCEL' });
  await waitFor(message => message.type === 'primary_text' && message.workflowId === worker && message.text.includes('ARCO_FIXTURE_WAITING_FOR_CANCEL'));
  send({ type: 'cancel', workflowId: worker });
  await waitFor(message => message.type === 'primary_turn_ended' && message.workflowId === worker);
  send({ type: 'user_message', workflowId: worker, content: 'ARCO_SMOKE_ECHO' });
  await waitFor(message => message.type === 'primary_text' && message.workflowId === worker && message.text.includes('ARCO_FIXTURE_REPLY'));
  await waitFor(message => message.type === 'primary_turn_ended' && message.workflowId === worker);
  await disconnect();
  console.log('PASS: active worker cancellation and subsequent turn');
  return { coordinator, worker, local, clusterId: id, taskId: task.id, artifactName: review.artifactName };
}
