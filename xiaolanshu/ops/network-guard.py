#!/usr/bin/env python3
"""A narrow host INPUT guard. Private deployment identities belong in JSON.

Exit codes: 0 ready/removed, 2 invalid config, 3 verified fail-closed policy
(proxy unavailable), 4 operation/check failure. No addresses or Docker metadata
are printed. Only this program's chain and tagged INPUT jumps are changed.
"""
import argparse
import contextlib
import ipaddress
import json
import os
import re
import shlex
import stat
import subprocess
import sys
import time

CHAIN = "PODWHALE-GUARD"
OWNER = "podwhale-network-guard:v1"
CONFIG = "/etc/podwhale-network-guard.json"
LOCK_DIR = "/run/podwhale-network-guard"
LABEL_PROJECT = "com.docker.compose.project"
LABEL_SERVICE = "com.docker.compose.service"
FAMILIES = ("iptables", "ip6tables")


class GuardError(Exception):
    def __init__(self, reason, code=4):
        super().__init__(reason)
        self.reason = reason
        self.code = code


class Runner:
    """argv only; child logs are private and never incorporated into errors."""
    def run(self, argv, input_text=None, timeout=12):
        try:
            result = subprocess.run(argv, input=input_text, text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise GuardError("command_unavailable_or_timeout") from None
        if result.returncode != 0:
            raise GuardError("command_failed")
        return result.stdout


def executable(name):
    # Do not permit a writable PATH entry to choose privileged executables.
    for directory in ("/usr/sbin", "/usr/bin", "/sbin", "/bin"):
        target = os.path.join(directory, name)
        if os.path.isfile(target) and os.access(target, os.X_OK):
            return target
    raise GuardError("required_executable_missing")


def validate_config(value):
    required = {"port", "appHost", "proxyProject", "proxyService", "proxyNetwork"}
    if (not isinstance(value, dict) or not required.issubset(value)
            or set(value) - required - {"configVersion"}
            or type(value.get("configVersion", 1)) is not int
            or value.get("configVersion", 1) != 1):
        raise GuardError("config_schema_invalid", 2)
    port = value["port"]
    # This helper is for an application port, never privileged SSH/web ports.
    if isinstance(port, bool) or not isinstance(port, int) or not 1024 <= port <= 65535:
        raise GuardError("config_port_invalid", 2)
    try:
        if not isinstance(value["appHost"], str):
            raise ValueError()
        app = ipaddress.ip_address(value["appHost"])
    except (ValueError, TypeError):
        raise GuardError("config_app_host_invalid", 2) from None
    private_ranges = (ipaddress.ip_network("10.0.0.0/8"),
                      ipaddress.ip_network("172.16.0.0/12"),
                      ipaddress.ip_network("192.168.0.0/16"))
    if app.version != 4 or not any(app in network for network in private_ranges):
        raise GuardError("config_app_host_invalid", 2)
    for key in ("proxyProject", "proxyService", "proxyNetwork"):
        if (not isinstance(value[key], str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", value[key])):
            raise GuardError("config_proxy_identity_invalid", 2)
    return dict(value, appHost=str(app))


def read_config(file):
    try:
        if not os.path.isabs(file):
            raise GuardError("config_path_invalid", 2)
        # Refuse symlinks and files readable/writable by another account.
        descriptor = os.open(file, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
            info = os.fstat(handle.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
                    or stat.S_IMODE(info.st_mode) & 0o077):
                raise GuardError("config_must_be_root_private", 2)
            if info.st_size > 16384:
                raise GuardError("config_too_large", 2)
            raw = handle.read(16385)
        if len(raw) > 16384:
            raise GuardError("config_too_large", 2)
        return validate_config(json.loads(raw))
    except GuardError:
        raise
    except (OSError, ValueError, TypeError):
        raise GuardError("config_unreadable_or_invalid", 2) from None


@contextlib.contextmanager
def operation_lock(read_only=False):
    import fcntl
    path = os.path.join(LOCK_DIR, "guard.lock")
    if read_only and not os.path.exists(path):
        yield
        return
    if not read_only:
        os.makedirs(LOCK_DIR, mode=0o700, exist_ok=True)
        directory = os.stat(LOCK_DIR, follow_symlinks=False)
        if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0
                or stat.S_IMODE(directory.st_mode) & 0o077):
            raise GuardError("unsafe_lock_directory")
    flags = os.O_RDONLY if read_only else os.O_RDWR | os.O_CREAT
    fd = os.open(path, flags | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
                or stat.S_IMODE(info.st_mode) & 0o077):
            raise GuardError("unsafe_lock_file")
        lock_type = fcntl.LOCK_SH if read_only else fcntl.LOCK_EX
        deadline = time.monotonic() + 8
        while True:
            try:
                fcntl.flock(fd, lock_type | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise GuardError("guard_busy") from None
                time.sleep(0.05)
        yield
    finally:
        os.close(fd)


def discover_proxy(config, runner):
    """Return exact running Compose peers on one verified bridge network."""
    try:
        docker = executable("docker")
        network_data = json.loads(runner.run([docker, "network", "inspect", "--", config["proxyNetwork"]]))
        if not isinstance(network_data, list) or len(network_data) != 1:
            raise GuardError("proxy_network_invalid")
        network = network_data[0]
        identity = network.get("Id", "")
        if (network.get("Name") != config["proxyNetwork"] or network.get("Driver") != "bridge"
                or not re.fullmatch(r"[a-f0-9]{64}", identity)):
            raise GuardError("proxy_network_invalid")
        bridge = (network.get("Options") or {}).get("com.docker.network.bridge.name")
        if not bridge:
            bridge = "docker0" if network["Name"] == "bridge" else "br-" + identity[:12]
        if (not isinstance(bridge, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,15}", bridge)
                or not os.path.isdir(os.path.join("/sys/class/net", bridge))):
            raise GuardError("proxy_bridge_unavailable")
        subnets = []
        for entry in (network.get("IPAM") or {}).get("Config", []):
            subnet = ipaddress.ip_network(entry.get("Subnet", ""), strict=False)
            if subnet.version == 4:
                subnets.append(subnet)
        if not subnets:
            raise GuardError("proxy_network_invalid")
        output = runner.run([docker, "ps", "--filter", "status=running",
                             "--filter", "label=" + LABEL_PROJECT + "=" + config["proxyProject"],
                             "--filter", "label=" + LABEL_SERVICE + "=" + config["proxyService"],
                             "--format", "{{.ID}}"])
        ids = output.split()
        if not ids:
            raise GuardError("proxy_not_found")
        if len(ids) > 32 or any(not re.fullmatch(r"[a-f0-9]{12,64}", item) for item in ids):
            raise GuardError("proxy_identity_invalid")
        containers = json.loads(runner.run([docker, "inspect", "--type", "container", "--"] + ids))
        if not isinstance(containers, list) or len(containers) != len(ids):
            raise GuardError("proxy_identity_invalid")
        addresses = set()
        for container in containers:
            labels = (container.get("Config") or {}).get("Labels") or {}
            if (labels.get(LABEL_PROJECT) != config["proxyProject"]
                    or labels.get(LABEL_SERVICE) != config["proxyService"]
                    or (container.get("State") or {}).get("Running") is not True):
                raise GuardError("proxy_identity_invalid")
            attached = ((container.get("NetworkSettings") or {}).get("Networks") or {}).get(config["proxyNetwork"])
            if not attached or attached.get("NetworkID") != identity:
                raise GuardError("proxy_network_mismatch")
            address = ipaddress.ip_address(attached.get("IPAddress", ""))
            if (address.version != 4 or address.is_unspecified or address.is_loopback
                    or address.is_multicast or not any(address in subnet for subnet in subnets)):
                raise GuardError("proxy_address_invalid")
            addresses.add(str(address))
        if len(addresses) != len(ids):
            raise GuardError("proxy_address_invalid")
        return {"bridge": bridge, "addresses": sorted(addresses), "reason": None}
    except GuardError as error:
        allowed = {"proxy_network_invalid", "proxy_bridge_unavailable", "proxy_not_found",
                   "proxy_identity_invalid", "proxy_network_mismatch", "proxy_address_invalid"}
        return {"bridge": None, "addresses": [], "reason": error.reason if error.reason in allowed else "docker_unavailable"}
    except (ValueError, TypeError, KeyError, AttributeError):
        return {"bridge": None, "addresses": [], "reason": "docker_metadata_invalid"}


def tagged(tokens):
    return list(tokens) + ["-m", "comment", "--comment", OWNER]


def chain_rules(config, proxy, family):
    result = [tagged(["-i", "lo"]) + ["-j", "RETURN"]]
    if family == "iptables" and not proxy["reason"]:
        for address in proxy["addresses"]:
            result.append(tagged(["-s", address + "/32", "-d", config["appHost"] + "/32",
                                  "-i", proxy["bridge"], "-p", "tcp", "-m", "tcp",
                                  "--dport", str(config["port"])]) + ["-j", "RETURN"])
    result.append(tagged(["-p", "tcp"]) + ["-j", "REJECT", "--reject-with", "tcp-reset"])
    return result


def jump_rule(port):
    return tagged(["-p", "tcp", "-m", "tcp", "--dport", str(port)]) + ["-j", CHAIN]


def normalized(tokens):
    """Compare iptables-save semantics, tolerating option/module order."""
    options, modules = {}, []
    known = {"-s", "-d", "-i", "-p", "--dport", "--comment", "-j", "--reject-with", "-m"}
    i = 0
    while i < len(tokens):
        key = tokens[i]
        if key not in known or i + 1 >= len(tokens):
            raise GuardError("unexpected_owned_rule")
        value = tokens[i + 1]
        if key == "-m":
            modules.append(value)
        elif key in options:
            raise GuardError("unexpected_owned_rule")
        else:
            if key in ("-s", "-d"):
                try:
                    value = str(ipaddress.ip_network(value, strict=False))
                except ValueError:
                    raise GuardError("unexpected_owned_rule") from None
            options[key] = value
        i += 2
    if options.get("-p") == "tcp" and "tcp" not in modules:
        modules.append("tcp")
    return tuple(sorted(options.items())), tuple(sorted(modules))


def own_jump(tokens):
    try:
        port = int(tokens[tokens.index("--dport") + 1])
        return 1 <= port <= 65535 and normalized(tokens) == normalized(jump_rule(port))
    except (ValueError, IndexError, GuardError):
        return False


def targets_own_chain(tokens):
    return any(tokens[i] in ("-j", "-g") and tokens[i + 1] == CHAIN for i in range(len(tokens) - 1))


def has_tag(tokens):
    return any(tokens[i] == "--comment" and tokens[i + 1] == OWNER for i in range(len(tokens) - 1))


def parse_save(text):
    chains, rules = set(), {}
    try:
        for line in text.splitlines():
            if line.startswith(":"):
                chains.add(line[1:].split()[0])
            elif line.startswith("-A "):
                words = shlex.split(line)
                rules.setdefault(words[1], []).append(words[2:])
    except (ValueError, IndexError):
        raise GuardError("firewall_snapshot_invalid") from None
    return {"chains": chains, "rules": rules}


def snapshot(runner, family):
    return parse_save(runner.run([executable(family + "-save"), "-t", "filter"]))


def assert_ownership(state):
    if any(not has_tag(rule) for rule in state["rules"].get(CHAIN, [])):
        raise GuardError("chain_ownership_conflict")
    for chain, rules in state["rules"].items():
        for rule in rules:
            if targets_own_chain(rule) and (chain != "INPUT" or not own_jump(rule)):
                raise GuardError("jump_ownership_conflict")


def restore(runner, family, lines):
    # One filter-table commit, no flush of any other chain/table or policy.
    payload = "*filter\n" + "\n".join(lines) + "\nCOMMIT\n"
    runner.run([executable(family + "-restore"), "--noflush", "--wait", "5"], payload)


def rebuild_chain(runner, family, rules):
    restore(runner, family, [":" + CHAIN + " - [0:0]", "-F " + CHAIN]
            + ["-A " + CHAIN + " " + " ".join(rule) for rule in rules])


def ensure_first_jump(runner, family, port):
    state = snapshot(runner, family)
    assert_ownership(state)
    incoming = state["rules"].get("INPUT", [])
    owned = [rule for rule in incoming if own_jump(rule)]
    if (incoming and own_jump(incoming[0]) and normalized(incoming[0]) == normalized(jump_rule(port))
            and len(owned) == 1):
        return
    # Exact tagged deletion avoids deleting a vendor rule if its index changes.
    # Deletion and first-position insertion share a single atomic commit.
    lines = ["-D INPUT " + " ".join(rule) for rule in owned]
    lines.append("-I INPUT 1 " + " ".join(jump_rule(port)))
    restore(runner, family, lines)


def policy_matches(state, config, proxy, family):
    try:
        assert_ownership(state)
        expected = chain_rules(config, proxy, family)
        actual = state["rules"].get(CHAIN, [])
        incoming = state["rules"].get("INPUT", [])
        return (CHAIN in state["chains"] and len(actual) == len(expected)
                and all(normalized(a) == normalized(b) for a, b in zip(actual, expected))
                and bool(incoming) and own_jump(incoming[0])
                and normalized(incoming[0]) == normalized(jump_rule(config["port"]))
                and sum(1 for rule in incoming if own_jump(rule)) == 1)
    except GuardError:
        return False


def apply_guard(config, runner, proxy=None):
    if proxy is None:
        proxy = discover_proxy(config, runner)
    # Validate ownership in both families before changing either one.
    for family in FAMILIES:
        assert_ownership(snapshot(runner, family))
    for family in FAMILIES:
        rebuild_chain(runner, family, chain_rules(config, proxy, family))
        ensure_first_jump(runner, family, config["port"])
    if not all(policy_matches(snapshot(runner, family), config, proxy, family) for family in FAMILIES):
        raise GuardError("policy_verification_failed")
    return {"status": "fail_closed" if proxy["reason"] else "ready", "protected": True,
            "reason": proxy["reason"], "proxyCount": len(proxy["addresses"])}, 3 if proxy["reason"] else 0


def check_guard(config, runner):
    proxy = discover_proxy(config, runner)
    matched = all(policy_matches(snapshot(runner, family), config, proxy, family) for family in FAMILIES)
    if not matched:
        raise GuardError("policy_mismatch")
    return {"status": "fail_closed" if proxy["reason"] else "ready", "protected": True,
            "reason": proxy["reason"], "proxyCount": len(proxy["addresses"])}, 3 if proxy["reason"] else 0


def remove_guard(config, runner):
    states = {family: snapshot(runner, family) for family in FAMILIES}
    for state in states.values():
        assert_ownership(state)
    for family, state in states.items():
        incoming = state["rules"].get("INPUT", [])
        lines = ["-D INPUT " + " ".join(rule) for rule in incoming if own_jump(rule)]
        if CHAIN in state["chains"]:
            lines.extend(["-F " + CHAIN, "-X " + CHAIN])
        if lines:
            restore(runner, family, lines)
    for family in FAMILIES:
        state = snapshot(runner, family)
        if CHAIN in state["chains"] or any(targets_own_chain(rule) for rules in state["rules"].values() for rule in rules):
            raise GuardError("removal_verification_failed")
    return {"status": "removed", "protected": False}, 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Maintain a private proxy-only application INPUT policy")
    actions = parser.add_mutually_exclusive_group(required=True)
    for action in ("apply", "check", "remove"):
        actions.add_argument("--" + action, action="store_true")
    parser.add_argument("--config", default=CONFIG)
    args = parser.parse_args(argv)
    try:
        if getattr(os, "geteuid", lambda: -1)() != 0:
            raise GuardError("root_required", 2)
        config = read_config(args.config)
        runner = Runner()
        with operation_lock(read_only=args.check):
            if args.apply:
                output, code = apply_guard(config, runner)
            elif args.check:
                output, code = check_guard(config, runner)
            else:
                output, code = remove_guard(config, runner)
    except GuardError as error:
        output, code = {"status": "error", "reason": error.reason, "protected": None}, error.code
    except Exception:
        output, code = {"status": "error", "reason": "operation_failed", "protected": None}, 4
    print(json.dumps(output, sort_keys=True))
    return code


if __name__ == "__main__":
    sys.exit(main())
