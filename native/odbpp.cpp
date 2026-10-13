// C ABI over OdbDesign (https://github.com/nam20485/OdbDesign) for in-process
// use from the OpenCode plugin via bun:ffi.
//
// One call parses an ODB++ archive and returns exactly what the board index
// needs, as compact JSON:
//
//   { "name": "...",
//     "components": [ { "refDes", "part", "package", "side", "x", "y", "props": { k: v } } ],
//     "nets":       [ { "name", "pins": [ ["U1", "3"], ... ] } ] }
//
// The returned string is owned by the caller and released with odbpp_free().

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>

#include <unistd.h>

#include "OdbDesign.h"
#include "Logger.h"

using namespace Odb::Lib;

namespace
{
	thread_local std::string g_lastError;

	void writeString(std::ostringstream& out, const std::string& s)
	{
		out << '"';
		for (unsigned char c : s)
		{
			switch (c)
			{
			case '"': out << "\\\""; break;
			case '\\': out << "\\\\"; break;
			case '\n': out << "\\n"; break;
			case '\r': out << "\\r"; break;
			case '\t': out << "\\t"; break;
			default:
				if (c < 0x20)
				{
					char buf[8];
					std::snprintf(buf, sizeof(buf), "\\u%04x", c);
					out << buf;
				}
				else
				{
					out << c;
				}
			}
		}
		out << '"';
	}

	const char* sideName(BoardSide side)
	{
		switch (side)
		{
		case BoardSide::Top: return "Top";
		case BoardSide::Bottom: return "Bottom";
		default: return "BsNone";
		}
	}

	char* dup(const std::string& s)
	{
		auto* p = static_cast<char*>(std::malloc(s.size() + 1));
		if (p) std::memcpy(p, s.c_str(), s.size() + 1);
		return p;
	}

	void quietLogger()
	{
		static bool done = false;
		if (done) return;
		done = true;
		// The library logs through a background thread to stdout and a log file.
		// Inside OpenCode stdout belongs to the TUI, so keep errors on stderr only.
		// ODB_DEBUG=1 logs everything OdbDesign has to say (it ends up in error messages).
		auto* logger = Utils::Logger::instance();
		logger->outputTypes(Utils::Logger::OutputTypes::StdErr);
		const char* debug = std::getenv("ODB_DEBUG");
		logger->logLevel(debug && *debug && std::strcmp(debug, "0") != 0 ? Utils::Logger::Level::Debug : Utils::Logger::Level::Error);
		logger->start();
	}

	// OdbDesign reports why a parse failed only on stderr (its logger thread and
	// libarchive), which nobody sees inside OpenCode, and then throws a generic
	// error. Capture stderr while parsing so failures can carry the real reason.
	class StderrCapture
	{
	public:
		StderrCapture()
		{
			std::fflush(stderr);
			m_file = std::tmpfile();
			m_saved = ::dup(STDERR_FILENO);
			if (!m_file || m_saved < 0 || dup2(fileno(m_file), STDERR_FILENO) < 0) release();
		}

		~StderrCapture() { finish(); }

		// Stop capturing and return what was written, after the logger thread
		// caught up (it logs asynchronously). The text is also passed on to the
		// real stderr, so nothing is swallowed.
		std::string finish()
		{
			if (!m_file) return "";
			static std::atomic<int> counter{0};
			const std::string marker = "odbpp-sync-" + std::to_string(++counter);
			Utils::Logger::instance()->error(marker);
			std::string text;
			for (int i = 0; i < 200; i++)
			{
				std::fflush(stderr);
				std::cerr.flush();
				text = read();
				if (text.find(marker) != std::string::npos) break;
				std::this_thread::sleep_for(std::chrono::milliseconds(5));
			}
			release();
			// Drop the sync line.
			auto at = text.find(marker);
			if (at != std::string::npos)
			{
				auto start = text.rfind('\n', at);
				auto end = text.find('\n', at);
				text.erase(start == std::string::npos ? 0 : start + 1, end == std::string::npos ? std::string::npos : end - start);
			}
			if (!text.empty()) std::fwrite(text.data(), 1, text.size(), stderr);
			return text;
		}

	private:
		std::FILE* m_file = nullptr;
		int m_saved = -1;

		std::string read()
		{
			std::string text;
			char buf[4096];
			ssize_t n;
			off_t at = 0;
			while ((n = pread(fileno(m_file), buf, sizeof(buf), at)) > 0)
			{
				text.append(buf, n);
				at += n;
			}
			return text;
		}

		void release()
		{
			if (m_saved >= 0)
			{
				std::fflush(stderr);
				dup2(m_saved, STDERR_FILENO);
				close(m_saved);
				m_saved = -1;
			}
			if (m_file)
			{
				std::fclose(m_file);
				m_file = nullptr;
			}
		}
	};

	// The last lines of captured output, without trailing blank lines.
	std::string tail(std::string text, size_t max = 2000)
	{
		while (!text.empty() && (text.back() == '\n' || text.back() == '\r' || text.back() == ' ')) text.pop_back();
		if (text.size() <= max) return text;
		auto cut = text.find('\n', text.size() - max);
		return "..." + text.substr(cut == std::string::npos ? text.size() - max : cut);
	}

	std::string boardJson(const std::string& path)
	{
		auto archive = std::make_shared<FileModel::Design::FileArchive>(path);
		if (!archive->ParseFileModel())
		{
			throw std::runtime_error("could not extract or parse ODB++ archive: " + path);
		}

		auto design = std::make_shared<ProductModel::Design>();
		if (!design->Build(archive))
		{
			throw std::runtime_error("could not build product model: " + path);
		}

		// refDes -> component layer record (placement + properties)
		std::unordered_map<std::string, std::shared_ptr<FileModel::Design::ComponentsFile::ComponentRecord>> records;
		if (auto step = archive->GetStepDirectory())
		{
			for (const auto& [layerName, layer] : step->GetLayersByName())
			{
				for (const auto& rec : layer->GetComponentsFile().GetComponentRecords())
				{
					records.emplace(rec->compName, rec);
				}
			}
		}

		std::ostringstream out;
		out.precision(10);
		out << "{\"name\":";
		writeString(out, design->GetName());

		out << ",\"components\":[";
		bool first = true;
		for (const auto& comp : design->GetComponents())
		{
			if (!first) out << ',';
			first = false;
			out << "{\"refDes\":";
			writeString(out, comp->GetRefDes());
			out << ",\"part\":";
			writeString(out, comp->GetPartName());
			if (auto pkg = comp->GetPackage())
			{
				out << ",\"package\":";
				writeString(out, pkg->GetName());
			}
			out << ",\"side\":\"" << sideName(comp->GetSide()) << '"';

			auto rec = records.find(comp->GetRefDes());
			if (rec != records.end())
			{
				out << ",\"x\":" << rec->second->locationX << ",\"y\":" << rec->second->locationY;
				out << ",\"props\":{";
				bool firstProp = true;
				for (const auto& prop : rec->second->m_propertyRecords)
				{
					if (!firstProp) out << ',';
					firstProp = false;
					writeString(out, prop->name);
					out << ':';
					writeString(out, prop->value);
				}
				out << '}';
			}
			out << '}';
		}

		out << "],\"nets\":[";
		first = true;
		for (const auto& net : design->GetNets())
		{
			if (!first) out << ',';
			first = false;
			out << "{\"name\":";
			writeString(out, net->GetName());
			out << ",\"pins\":[";
			bool firstPin = true;
			for (const auto& pc : net->GetPinConnections())
			{
				auto comp = pc->GetComponent();
				auto pin = pc->GetPin();
				if (!comp || !pin) continue;
				if (!firstPin) out << ',';
				firstPin = false;
				out << '[';
				writeString(out, comp->GetRefDes());
				out << ',';
				writeString(out, pin->GetName());
				out << ']';
			}
			out << "]}";
		}
		out << "]}";
		return out.str();
	}
}

extern "C"
{
	// Parse an ODB++ archive (.tgz/.zip) and return the board as JSON, or
	// NULL on failure (see odbpp_last_error). The archive is extracted next to
	// itself, so callers should pass a copy in a scratch directory.
	char* odbpp_load_board(const char* path)
	{
		quietLogger();
		g_lastError.clear();
		StderrCapture capture;
		try
		{
			auto json = boardJson(path ? path : "");
			capture.finish();
			return dup(json);
		}
		catch (const std::exception& e)
		{
			g_lastError = e.what();
		}
		catch (...)
		{
			g_lastError = "unknown error";
		}
		auto log = tail(capture.finish());
		if (!log.empty()) g_lastError += "\nOdbDesign output:\n" + log;
		return nullptr;
	}

	const char* odbpp_last_error()
	{
		return g_lastError.c_str();
	}

	void odbpp_free(char* p)
	{
		std::free(p);
	}
}
