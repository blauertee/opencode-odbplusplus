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

#include <cstdlib>
#include <cstring>
#include <exception>
#include <memory>
#include <sstream>
#include <string>
#include <unordered_map>

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
		auto* logger = Utils::Logger::instance();
		logger->outputTypes(Utils::Logger::OutputTypes::StdErr);
		logger->logLevel(Utils::Logger::Level::Error);
		logger->start();
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
		try
		{
			quietLogger();
			g_lastError.clear();
			return dup(boardJson(path ? path : ""));
		}
		catch (const std::exception& e)
		{
			g_lastError = e.what();
		}
		catch (...)
		{
			g_lastError = "unknown error";
		}
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
