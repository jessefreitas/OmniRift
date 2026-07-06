import json
import os
import sys

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks"))
import stop_evidence_gate as m

# eventos simplificados: (kind, name, text)
EDIT = {"kind": "tool_use", "name": "Edit", "text": ""}
GREEN = {"kind": "tool_result", "name": "Bash", "text": "5 passed\nexit_code: 0"}
RED = {"kind": "tool_result", "name": "Bash", "text": "1 failed\nexit_code: 1"}


def _claim(text="Pronto, corrigido e funcionando."):
    return {"kind": "text", "name": "", "text": text}


def test_claims_success():
    assert m.claims_success("corrigido!")
    assert m.claims_success("está funcionando agora")
    assert m.claims_success("pronto, resolvido")
    assert not m.claims_success("vou investigar o erro")
    assert not m.claims_success("o teste falhou")


def test_bloqueia_claim_sem_execucao_apos_edit():
    events = [EDIT, _claim()]
    assert m.should_block(events) is True


def test_libera_claim_com_execucao_verde_apos_edit():
    events = [EDIT, GREEN, _claim()]
    assert m.should_block(events) is False


def test_bloqueia_se_execucao_apos_edit_foi_vermelha():
    events = [EDIT, RED, _claim()]
    assert m.should_block(events) is True


def test_libera_sem_claim_de_sucesso():
    events = [EDIT, _claim("ainda estou debugando")]
    assert m.should_block(events) is False


def test_libera_sem_nenhuma_edicao():
    events = [_claim()]
    assert m.should_block(events) is False


def test_parse_transcript(tmp_path):
    t = tmp_path / "t.jsonl"
    lines = [
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Edit", "input": {}}]}},
        {"type": "user", "message": {"content": [
            {"type": "tool_result", "content": "5 passed"}]}},
        {"type": "assistant", "message": {"content": [
            {"type": "text", "text": "corrigido"}]}},
    ]
    t.write_text("\n".join(json.dumps(l) for l in lines))
    events = m.parse_transcript(str(t))
    assert [e["kind"] for e in events] == ["tool_use", "tool_result", "text"]
    assert events[0]["name"] == "Edit"


def test_stop_hook_active_nunca_bloqueia(tmp_path):
    t = tmp_path / "t.jsonl"
    t.write_text(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "Edit", "input": {}}]}}) + "\n" +
        json.dumps({"type": "assistant", "message": {"content": [
            {"type": "text", "text": "corrigido"}]}}))
    out = m.decide({"transcript_path": str(t), "stop_hook_active": True})
    assert out is None
    out = m.decide({"transcript_path": str(t), "stop_hook_active": False})
    assert out["decision"] == "block"
